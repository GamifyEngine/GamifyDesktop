import { app, nativeImage } from 'electron'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { ensureProjectStateDir } from './chat-history'
import { getCurrentProject } from '../state'
import { sendToRenderer } from '../window'
import {
  consumeTestBudget,
  getGameLogs,
  getGameState,
  runTestCommand,
  runTestInput,
  startGameTest,
  stopGame,
  type TestInputAction
} from './game'
import { imageGenerationRoute } from './chat-setup'
import { generateImageAsset } from './gptimage'
import { generateAsset, isHy3dConfigured, type GenerateAssetRequest } from './hy3d'
import { downloadItchAsset, searchItchAssets } from './itch'
import type { AssetPreview } from '../../shared/types'

/**
 * Local HTTP API that exposes the AI game-testing tools to the MCP bridge
 * (resources/mcp-bridge.mjs), which Codex spawns as a local MCP server.
 * The bridge finds us two ways (see getHarnessEndpoint / harness.json below),
 * so nothing machine-specific is written into any project or global config.
 * Bound to 127.0.0.1 and guarded by a per-launch random token.
 */

let server: Server | null = null
let endpoint: { port: number; token: string } | null = null

/**
 * This instance's harness address. Injected into the env of every Codex
 * server we spawn so the bridge always reaches THIS app instance. harness.json
 * can't provide that guarantee: it's one file shared by every GamifyDesktop
 * instance (dev + packaged can run side by side), so it holds whichever
 * instance registered last — the file is only a fallback for agent sessions
 * that weren't launched by the app.
 */
export function getHarnessEndpoint(): { port: number; token: string } | null {
  return endpoint
}

function harnessFilePath(): string {
  return join(app.getPath('userData'), 'harness.json')
}

/** Screenshots kept per capture — enough to compare a few frames, no unbounded growth. */
const KEEP_SHOTS = 12

/**
 * Screenshots live INSIDE the project (.gamifydesktop/test-shots/, gitignored and
 * .gdignore'd via ensureProjectStateDir). They used to go to the app's
 * userData dir, and handing that ~/Library path to the model lured it into
 * reading/copying outside the project — which the sandbox rejects (see
 * chat-sandbox.ts) and derailed agent runs. In-project, every agent (main,
 * game-tester) can read a shot by its relative path freely.
 */
async function pruneShots(dir: string): Promise<void> {
  try {
    // Epoch-ms filenames are fixed-width, so the lexicographic sort is chronological.
    const shots = (await readdir(dir)).filter((f) => /^shot-\d+\.png$/.test(f)).sort()
    for (const old of shots.slice(0, -KEEP_SHOTS)) await rm(join(dir, old), { force: true })
  } catch {
    // Housekeeping only — never fail the screenshot over it.
  }
}

interface ToolResult {
  ok: boolean
  text: string
  /** Base64 image for screenshot / asset-preview results. */
  imageBase64?: string
  /** MIME of imageBase64 (defaults to image/png in the bridge). */
  imageMime?: string
}

/** Longest edge / quality of the screenshot variant sent to the model. */
const SHOT_MAX_WIDTH = 1024
const SHOT_JPEG_QUALITY = 72

/**
 * Shrink a screenshot for the model: retina-scale PNGs (~0.5-0.7 MB each)
 * accumulate as base64 in the test agent's conversation and are re-sent on
 * every step — measured runs slowed from ~4s to ~27s per step and eventually
 * drew 413/500 responses from the model provider. A 1024-wide JPEG (~10x
 * smaller) is plenty to judge layout, art, and HUD text. The full-resolution
 * PNG stays on disk for the user and for later `read`s by the agents.
 */
function shrinkShotForModel(png: Buffer): { base64: string; mime: string } {
  try {
    let img = nativeImage.createFromBuffer(png)
    if (img.isEmpty()) throw new Error('unreadable screenshot')
    if (img.getSize().width > SHOT_MAX_WIDTH) img = img.resize({ width: SHOT_MAX_WIDTH })
    return { base64: img.toJPEG(SHOT_JPEG_QUALITY).toString('base64'), mime: 'image/jpeg' }
  } catch {
    // Conversion failed — better to send the big original than no image.
    return { base64: png.toString('base64'), mime: 'image/png' }
  }
}

/** Drop a generated-asset preview into the chat (ChatPanel renders it with a feedback button). */
function pushAssetPreview(base64: string, mime: string, label: string, files: string[], kind: AssetPreview['kind']): void {
  const preview: AssetPreview = {
    dataUrl: `data:${mime};base64,${base64}`,
    label,
    // The asset's containing folder (first written file's directory).
    path: files[0]?.split('/').slice(0, -1).join('/') ?? 'assets',
    kind
  }
  sendToRenderer('chat:asset-preview', preview)
}

/** The per-run budget applies to these (each one costs a model round trip). */
const BUDGETED_TOOLS = new Set(['game_input', 'game_state', 'game_scene_tree', 'game_screenshot', 'game_logs'])

async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!BUDGETED_TOOLS.has(name)) return dispatchTool(name, args)
  // See consumeTestBudget (game.ts) for why runaway test runs must be capped.
  // game_logs stays usable past exhaustion so the final report can quote logs.
  const budget = consumeTestBudget()
  if (budget.exhausted && name !== 'game_logs') return { ok: false, text: budget.notice! }
  const result = await dispatchTool(name, args)
  if (budget.notice && result.ok) result.text = `${result.text}\n\n${budget.notice}`
  return result
}

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'run_game_test': {
      const project = getCurrentProject()
      if (!project) return { ok: false, text: 'No project is open in GamifyDesktop.' }
      await startGameTest(project.path)
      // Windowed fallback platforms have no off-screen embedding — say where
      // the game actually went so the model reports it accurately.
      const where = getGameState().view === 'external'
        ? 'Game is running in a separate visible window (off-screen embedding is macOS-only; all game_* tools still work).'
        : 'Game is running off-screen.'
      return { ok: true, text: `${where} Use game_input / game_screenshot / game_state to interact and observe, and stop_game_test when finished.` }
    }
    case 'stop_game_test':
      stopGame()
      return { ok: true, text: 'Game stopped.' }
    case 'game_input': {
      const actions = args.actions as TestInputAction[] | undefined
      if (!Array.isArray(actions) || actions.length === 0) {
        return { ok: false, text: 'Provide a non-empty "actions" array.' }
      }
      await runTestInput(actions)
      return { ok: true, text: `Executed ${actions.length} input action(s).` }
    }
    case 'game_screenshot': {
      const project = getCurrentProject()
      if (!project) return { ok: false, text: 'No project is open in GamifyDesktop.' }
      const dir = join(await ensureProjectStateDir(project.path), 'test-shots')
      mkdirSync(dir, { recursive: true })
      const file = `shot-${Date.now()}.png`
      const reply = await runTestCommand('screenshot', [join(dir, file)], 15000)
      if (!reply.ok) return { ok: false, text: reply.text }
      const png = await readFile(join(dir, file))
      const shot = shrinkShotForModel(png)
      // Mirror what the AI sees into the UI (chat + game-view test monitor).
      sendToRenderer('game:test-shot', `data:${shot.mime};base64,${shot.base64}`)
      void pruneShots(dir)
      // Relative path only: an absolute path outside the project sent agents
      // on denied out-of-project reads (the incident this tool text prevents).
      return {
        ok: true,
        text:
          `Screenshot saved inside the project at .gamifydesktop/test-shots/${file}. ` +
          'Look at the attached image now; read that path to see it again later — ' +
          'never copy screenshots elsewhere.',
        imageBase64: shot.base64,
        imageMime: shot.mime
      }
    }
    case 'game_state': {
      const expression = String(args.expression ?? '')
      if (!expression) return { ok: false, text: 'Provide a GDScript "expression".' }
      return { ...(await runTestCommand('eval', [expression])) }
    }
    case 'game_scene_tree':
      return { ...(await runTestCommand('tree', [])) }
    case 'game_logs': {
      const logs = getGameLogs()
      const state = getGameState()
      return {
        ok: true,
        text: `status=${state.status} mode=${state.mode ?? 'none'}\n${logs.slice(-100).join('\n') || '(no output yet)'}`
      }
    }
    case 'generate_3d_asset': {
      const project = getCurrentProject()
      if (!project) return { ok: false, text: 'No project is open in GamifyDesktop.' }
      const result = await generateAsset(project.path, {
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        imagePath: typeof args.image_path === 'string' ? args.image_path : undefined,
        folder: String(args.folder ?? ''),
        name: String(args.name ?? ''),
        faceCount: typeof args.face_count === 'number' ? args.face_count : undefined,
        generateType: args.generate_type as GenerateAssetRequest['generateType'],
        enablePBR: typeof args.enable_pbr === 'boolean' ? args.enable_pbr : undefined
      })
      // Written outside the agent's own file edits — nudge the sidebar panels.
      sendToRenderer('chat:files-changed')
      // Show the turntable (or still) in the chat so the user can react to it.
      const chatPreview = result.turntableBase64 ?? result.previewBase64
      const chatMime = result.turntableBase64 ? result.turntableMime : result.previewMime
      if (chatPreview && chatMime) {
        pushAssetPreview(chatPreview, chatMime, String(args.name ?? 'asset'), result.files, '3d')
      }
      return {
        ok: true,
        text:
          `3D asset generated. Files written:\n${result.files.map((f) => `- ${f}`).join('\n')}\n` +
          'Godot auto-imports these under res:// — instance the model in a scene to use it. ' +
          'The user sees this preview in the chat and may reply with feedback; if they do, regenerate with the same folder and name.',
        imageBase64: result.previewBase64,
        imageMime: result.previewMime
      }
    }
    case 'generate_2d_asset': {
      const project = getCurrentProject()
      if (!project) return { ok: false, text: 'No project is open in GamifyDesktop.' }
      const result = await generateImageAsset(
        project.path,
        {
          prompt: String(args.prompt ?? ''),
          folder: String(args.folder ?? ''),
          name: String(args.name ?? '')
        },
        await imageGenerationRoute()
      )
      sendToRenderer('chat:files-changed')
      pushAssetPreview(result.previewBase64, result.previewMime, String(args.name ?? 'asset'), result.files, '2d')
      return {
        ok: true,
        text:
          `2D asset generated (1024×1024 PNG, transparent background). Files written:\n${result.files.map((f) => `- ${f}`).join('\n')}\n` +
          'Godot auto-imports it under res:// as a texture. ' +
          'The user sees this preview in the chat and may reply with feedback; if they do, regenerate with the same folder and name.',
        imageBase64: result.previewBase64,
        imageMime: result.previewMime
      }
    }
    case 'itch_search': {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, text: 'Provide a "query" to search itch.io for.' }
      return { ok: true, text: await searchItchAssets(query) }
    }
    case 'itch_download': {
      const project = getCurrentProject()
      if (!project) return { ok: false, text: 'No project is open in GamifyDesktop.' }
      const text = await downloadItchAsset(project.path, String(args.url ?? ''))
      // Staged under .gamifydesktop/ (hidden from the sidebar today), but keep
      // the post-write convention the other file-writing tools follow.
      sendToRenderer('chat:files-changed')
      return { ok: true, text }
    }
    default:
      return { ok: false, text: `Unknown tool: ${name}` }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) {
        // Tear the request down too — rejecting alone would leave the socket
        // streaming data into `body` with nobody ever reading the result.
        req.destroy()
        reject(new Error('request too large'))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/** Constant-time token check — `!==` would leak prefix-match timing to other local users. */
function tokenMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false
  const a = Buffer.from(header)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function startTestHarness(): void {
  const token = randomBytes(24).toString('hex')

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (!tokenMatches(req.headers['x-gamifydesktop-token'], token)) {
      respond(403, { ok: false, text: 'invalid token' })
      return
    }
    // Which optional tools are available — the MCP bridge checks this at
    // startup so unconfigured tools are never offered to the model.
    if (req.method === 'GET' && req.url === '/capabilities') {
      respond(200, { hy3d: await isHy3dConfigured(), gptImage: (await imageGenerationRoute()) !== null })
      return
    }
    if (req.method !== 'POST' || req.url !== '/tool') {
      respond(404, { ok: false, text: 'not found' })
      return
    }
    try {
      const { name, arguments: args } = JSON.parse(await readBody(req)) as {
        name: string
        arguments?: Record<string, unknown>
      }
      respond(200, await runTool(name, args ?? {}))
    } catch (err) {
      respond(200, { ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  })

  server.listen(0, '127.0.0.1', () => {
    const address = server?.address()
    const port = typeof address === 'object' && address ? address.port : 0
    endpoint = { port, token }
    // Fallback discovery for agent sessions not spawned by the app.
    // Owner-only like the credential files: the token authorizes tool calls
    // (GDScript eval, input injection) on a loopback server every local user
    // can reach. `mode` only applies on creation, so chmod also fixes up a
    // file left behind by an older build with default permissions.
    writeFileSync(harnessFilePath(), JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 })
    chmodSync(harnessFilePath(), 0o600)
  })
}

export function stopTestHarness(): void {
  server?.close()
  server = null
  // Only remove harness.json if it still holds OUR registration. Another
  // GamifyDesktop instance may have overwritten it since we launched (the file is
  // shared), and deleting theirs would strand that still-running instance —
  // this exact race broke the packaged app while a dev instance quit.
  try {
    const current = JSON.parse(readFileSync(harnessFilePath(), 'utf8')) as { token?: string }
    if (current.token === endpoint?.token) rmSync(harnessFilePath(), { force: true })
  } catch {
    // Missing or unreadable — nothing of ours to clean up.
  }
  endpoint = null
}
