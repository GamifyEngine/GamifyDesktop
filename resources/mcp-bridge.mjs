#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) stdio server that exposes GamifyDesktop's game
 * testing tools to the Codex agent. It is a thin bridge: every tool call is
 * forwarded over HTTP to the running GamifyDesktop app. The app is discovered
 * via GAMIFYDESKTOP_HARNESS_PORT/TOKEN env vars (set by the app on the Codex
 * server it spawns and passed through to this process — always the right
 * instance), falling back to harness.json in GamifyDesktop's userData directory
 * for agent sessions that weren't launched by the app.
 *
 * Spawned by Codex (registered per spawn by the app, see codex-config.ts)
 * with Electron's binary in Node mode — no separate Node install needed.
 * Zero dependencies; speaks newline-delimited JSON-RPC 2.0 on stdio.
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

function userDataDir() {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'GamifyDesktop')
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'GamifyDesktop')
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'GamifyDesktop')
  }
}

function readHarness() {
  // Env vars come from the GamifyDesktop instance that spawned this Codex
  // server, so they can't point at the wrong instance and don't suffer the
  // shared-file races harness.json has when several instances run at once
  // (e.g. dev + packaged: one quitting used to delete the other's file).
  const { GAMIFYDESKTOP_HARNESS_PORT: envPort, GAMIFYDESKTOP_HARNESS_TOKEN: envToken } = process.env
  if (envPort && envToken) return { port: Number(envPort), token: envToken }
  try {
    return JSON.parse(readFileSync(join(userDataDir(), 'harness.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * node:http with timeout 0 — NOT fetch: undici aborts responses that take
 * more than 5 minutes to start, and 3D asset generation legitimately takes
 * longer than that.
 */
function harnessRequest(harness, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: harness.port,
        method,
        path,
        headers: { 'content-type': 'application/json', 'x-gamifydesktop-token': harness.token },
        timeout: 0
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error(`invalid harness response (HTTP ${res.statusCode})`))
          }
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(body ?? '')
  })
}

async function callHarness(name, args) {
  const harness = readHarness()
  if (!harness) {
    return { ok: false, text: 'GamifyDesktop does not appear to be running (harness.json not found). These tools only work while the GamifyDesktop app is open.' }
  }
  try {
    return await harnessRequest(harness, 'POST', '/tool', JSON.stringify({ name, arguments: args }))
  } catch (err) {
    return { ok: false, text: `Failed to reach GamifyDesktop: ${err.message}` }
  }
}

/** Optional-tool availability, checked once per bridge lifetime (per chat server). */
async function harnessCapabilities() {
  const harness = readHarness()
  if (!harness) return {}
  try {
    return await harnessRequest(harness, 'GET', '/capabilities')
  } catch {
    return {}
  }
}

const TOOLS = [
  {
    name: 'run_game_test',
    description:
      'Start the currently open GamifyDesktop game project for AI testing. The game runs the full native engine (rendering, physics) — off-screen on macOS, in a separate visible window on Windows/Linux; every game_* tool works the same either way. Always call this before other game_* tools, and stop_game_test when done.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'game_input',
    description:
      'Send scripted input to the running test game. Actions execute in order. Keys use DOM-style names ("ArrowLeft", "Space", "a", "Enter", "Escape"). Mouse coordinates are in game-view points from the top-left.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Sequence of input steps',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['key_press', 'key_down', 'key_up', 'mouse_click', 'mouse_move', 'wait'] },
              key: { type: 'string', description: 'For key_* actions' },
              holdMs: { type: 'number', description: 'key_press hold duration (default 60ms)' },
              x: { type: 'number' },
              y: { type: 'number' },
              button: { type: 'number', description: 'mouse button: 0 left, 1 middle, 2 right' },
              ms: { type: 'number', description: 'for wait' }
            },
            required: ['type']
          }
        }
      },
      required: ['actions']
    }
  },
  {
    name: 'game_screenshot',
    description:
      'Capture a PNG screenshot of the running test game. Returns the image (look at it) and saves it inside the project at .gamifydesktop/test-shots/ — read that saved path to see it again later. Never copy screenshots or read them from anywhere else.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'game_state',
    description:
      'Evaluate a GDScript expression against the running game\'s scene tree root and return the result as JSON. Examples: get_tree().current_scene.name · get_node("/root/Main").score · get_node("/root/Main/Score").text. Use this to assert game state without screenshots.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'GDScript expression (no statements)' } },
      required: ['expression']
    }
  },
  {
    name: 'game_scene_tree',
    description: 'Dump the running game\'s scene tree (node names, classes, hierarchy). Useful to discover node paths for game_state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'game_logs',
    description:
      'Get the game\'s recent console output (prints and script errors) and current run status. Includes "[gamifydesktop] fps" lines with frame-rate stats (avg/min/max/1% low/0.1% low per 60s window). The full frame-rate history across runs — including the user\'s own play sessions — persists in .gamifydesktop/perf.log; read that file when diagnosing performance problems.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'stop_game_test',
    description: 'Stop the running test game.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'itch_search',
    description:
      "Search itch.io's catalog of FREE game assets (sprites, tilesets, 3D models, audio, fonts) — no account needed. " +
      'Returns a numbered markdown list of asset pages with clickable links. Present that list to the user VERBATIM as numbered options, ' +
      "remind them to check each asset's license/attribution rules on its itch.io page, and ask them to pick before downloading. " +
      'Rate-limited: make ONE well-chosen search (e.g. "pixel art dungeon tileset"), not many variations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms, e.g. "pixel art dungeon tileset" or "low poly nature pack".' }
      },
      required: ['query']
    }
  },
  {
    name: 'itch_download',
    description:
      "Download a FREE asset from its itch.io page (URL shaped https://<author>.itch.io/<name>) into the project's .gamifydesktop/itch/ " +
      'staging folder — zip archives are auto-extracted — and return the file listing. Only free assets work (no purchases, no account). ' +
      'Staged files are INVISIBLE to Godot and git: afterwards copy just the pieces the user wants into the proper assets/ sub-folders ' +
      'with your file tools and wire them into scenes. Only call this after the user has picked an asset.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: "The asset's itch.io page URL, e.g. https://pixelfrog-assets.itch.io/kings-and-pigs." }
      },
      required: ['url']
    }
  }
]

/**
 * Offered only when 2D generation is available — the assistant runs on a
 * Gamify account, or the user configured an OpenAI API key in GamifyDesktop's
 * settings panel (checked via /capabilities at list time).
 */
const GPT_IMAGE_TOOL = {
  name: 'generate_2d_asset',
  description:
    'Generate a 2D image asset (sprite, icon, texture, UI art) with AI image generation and save it into the project\'s assets/ folder. ' +
    'Fixed output: one 1024×1024 PNG with a TRANSPARENT background at medium quality — ideal for sprites and icons. ' +
    'Takes ~10-60 seconds; returns the written file path plus the image itself so you can check it. ' +
    'Describe ONE subject per call (subject, colors/materials, art style, camera angle e.g. "top-down" or "side view for a platformer"). ' +
    'Organize assets to mirror the ECS layout: folder "entities/e_player" for that entity\'s art, "ui" for HUD art, "shared" for reusable pieces. ' +
    'If the user gives feedback on the preview, regenerate with the SAME folder and name so the files are replaced.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the image (one subject, style, colors, view angle).' },
      folder: { type: 'string', description: 'Destination under assets/, mirroring the ECS structure — e.g. "entities/e_player", "ui", "shared".' },
      name: { type: 'string', description: 'Asset name (lowercase slug), e.g. "coin-icon".' }
    },
    required: ['prompt', 'folder', 'name']
  }
}

/**
 * Offered only when the user has configured Tencent HY 3D credentials in
 * GamifyDesktop's setup panel (checked via /capabilities at list time).
 */
const HY3D_TOOL = {
  name: 'generate_3d_asset',
  description:
    'Generate a 3D model with Tencent HY 3D and save it into the project\'s assets/ folder. ' +
    'Takes 1-5 minutes — the call blocks until the model is ready and returns the written file paths plus a preview image. ' +
    'Describe ONE object per call (simple prompt: subject, shape, colors/materials, style). ' +
    'Organize assets to mirror the ECS layout: folder "entities/e_player" for that entity\'s model, "ui" for HUD art, "shared" for reusable pieces. ' +
    'Keep face_count modest for game use (default 60000; use generate_type "LowPoly" for stylized low-poly).',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the 3D object (max 1024 chars). Required unless image_path is given.' },
      image_path: { type: 'string', description: 'Project-relative path to a reference image (jpg/png/webp, single object on a plain background). Cannot be combined with prompt except in Sketch mode.' },
      folder: { type: 'string', description: 'Destination under assets/, mirroring the ECS structure — e.g. "entities/e_player", "ui", "shared".' },
      name: { type: 'string', description: 'Asset name (lowercase slug), e.g. "spaceship".' },
      face_count: { type: 'number', description: 'Polygon budget, 3000-1500000 (default 60000).' },
      generate_type: { type: 'string', enum: ['Normal', 'LowPoly', 'Geometry', 'Sketch'], description: 'Normal = textured model (default) · LowPoly = stylized reduced-poly · Geometry = untextured white model · Sketch = from a line drawing.' },
      enable_pbr: { type: 'boolean', description: 'Generate PBR materials (default true; ignored for Geometry).' }
    },
    required: ['folder', 'name']
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

async function handle(request) {
  const { id, method, params } = request
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'gamifydesktop', version: '0.1.0' }
      }
    })
  } else if (method === 'tools/list') {
    const caps = await harnessCapabilities()
    const tools = [...TOOLS]
    if (caps.hy3d) tools.push(HY3D_TOOL)
    if (caps.gptImage) tools.push(GPT_IMAGE_TOOL)
    send({ jsonrpc: '2.0', id, result: { tools } })
  } else if (method === 'tools/call') {
    const result = await callHarness(params.name, params.arguments ?? {})
    const content = []
    if (result.imageBase64) {
      content.push({ type: 'image', data: result.imageBase64, mimeType: result.imageMime ?? 'image/png' })
    }
    content.push({ type: 'text', text: result.text ?? (result.ok ? 'ok' : 'failed') })
    send({ jsonrpc: '2.0', id, result: { content, isError: !result.ok } })
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
  // Notifications (no id) are ignored.
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  handle(request).catch((err) => {
    if (request.id !== undefined) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(err?.message ?? err) } })
    }
  })
})
rl.on('close', () => process.exit(0))
