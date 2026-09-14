import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { request as httpRequest, get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { sendToRenderer } from '../window'
import { resolveOpencode } from './binaries'
import { loadTranscriptRecap, saveChatAttachments, saveChatUploads, type SavedUpload } from './chat-history'
// Benign import cycles (opencode-setup and opencode-config → opencode-setup
// import shutdownChat): all sides only use the other's exports at call time,
// never during module evaluation.
import { agentInstructionsPath, genieengineMcpEntry } from './opencode-config'
import { GAME_TESTER_AGENT, resolveChatModel } from './opencode-setup'
import { getHarnessEndpoint } from './test-harness'
import type { ChatAttachment, ChatModelTier, ChatPartUpdate, ChatToolStatus } from '../../shared/types'

/**
 * AI chat backed by a headless OpenCode server (https://opencode.ai).
 *
 * One `opencode serve` process runs per open project (sessions are bound to
 * the server's working directory). Messages go through the HTTP API and the
 * /event SSE stream feeds live progress — text deltas, reasoning and tool
 * invocations — so long agentic tasks show real activity in the chat instead
 * of a silent spinner. The blocking message POST provides the authoritative
 * final message state.
 */

interface OpencodeServer {
  proc: ChildProcess
  base: string
  projectPath: string
  stderrTail: string
  sseAbort: AbortController
  /** Set once the configured model's provider is confirmed available. */
  providerChecked?: boolean
}

let server: OpencodeServer | null = null
let sessionID: string | null = null
/** True while sessionID came from a saved chat file and hasn't been checked against the server. */
let sessionRestored = false
let busy = false
let cancelled = false
let filesChangedTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Message metadata by messageID (parts carry neither field themselves): role
 * filters the user's echoed message out of the stream, agent tells a subagent
 * session's parts apart so delegated work can be shown labelled in the chat.
 */
const messageMeta = new Map<string, { role: string; agent?: string }>()
/**
 * Accumulated text of streaming parts in the current turn, by partID.
 * message.part.updated only snapshots a part (empty on creation, full on
 * completion) — the characters in between arrive as message.part.delta
 * appends, so without this cache text and thinking would not stream at all.
 */
const partCache = new Map<string, ChatPartUpdate>()

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function waitForHealth(srv: OpencodeServer): Promise<void> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (srv.proc.exitCode !== null) {
      throw new Error(`OpenCode server exited unexpectedly: ${srv.stderrTail.trim() || 'no output'}`)
    }
    try {
      const res = await fetch(`${srv.base}/session`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('OpenCode server did not become ready in time')
}

/* eslint-disable @typescript-eslint/no-explicit-any -- SSE payloads are untyped JSON */
function translatePart(part: any): ChatPartUpdate | null {
  if (!part?.id || !part.messageID) return null
  if (part.type === 'text' || part.type === 'reasoning') {
    return { messageID: part.messageID, partID: part.id, kind: part.type, text: part.text ?? '' }
  }
  if (part.type === 'tool') {
    // Phantom calls: some model/provider combos (notably Kimi through
    // quantized OpenRouter hosts) emit malformed duplicate tool-call
    // fragments. OpenCode records them as tool "unknown" — they never
    // execute and the real call sits alongside, so they're pure noise.
    if (!part.tool || part.tool === 'unknown') return null
    const state = part.state ?? {}
    const status: ChatToolStatus = ['pending', 'running', 'completed', 'error'].includes(state.status)
      ? state.status
      : 'running'
    // Prefer the human title OpenCode assigns on completion; fall back to the
    // tool input (file path, subagent task description, or command) so
    // pending chips aren't blank.
    const input = state.input ?? {}
    const title: string =
      state.title ||
      input.filePath ||
      input.pattern ||
      input.description ||
      input.expression ||
      (typeof input.command === 'string' ? input.command : '') ||
      ''
    return {
      messageID: part.messageID,
      partID: part.id,
      kind: 'tool',
      tool: {
        name: part.tool ?? 'tool',
        status,
        title: String(title).slice(0, 200),
        // Why the call failed — shown as a tooltip on the red ✗ chip.
        error: status === 'error' && state.error ? String(state.error).slice(0, 500) : undefined
      }
    }
  }
  return null // step-start / step-finish / snapshot etc. — not user-facing
}

/**
 * External directories the agent may use freely: the OS scratch space, in
 * every spelling it shows up under (macOS /tmp is a symlink into /private,
 * and os.tmpdir() lives in /var/folders).
 */
const TEMP_ROOTS = [
  tmpdir(),
  ...(process.platform === 'darwin' ? ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'] : []),
  ...(process.platform === 'linux' ? ['/tmp'] : [])
]

function isUnderRoot(dir: string, root: string): boolean {
  // Windows paths compare case-insensitively.
  const [a, b] = process.platform === 'win32' ? [dir.toLowerCase(), root.toLowerCase()] : [dir, root]
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * OpenCode pauses the whole session until permission asks are answered, and
 * GenieEngine has no permission UI — unanswered asks would freeze the chat
 * forever. Policy, matching the CLI's autonomous behavior:
 *
 *  - external_directory asks for the OS temp dir are approved — shell
 *    commands legitimately stage scratch files in /tmp, and rejecting those
 *    made ordinary bash commands fail mid-turn;
 *  - other external_directory asks are rejected WITH feedback telling the
 *    agent to stay inside the project and where in-project copies of what it
 *    usually wants (screenshots, attachments) already live;
 *  - everything else is approved.
 *
 * A rejection only steers the model instead of stranding the run because
 * ensureOpencodeConfig sets experimental.continue_loop_on_deny — without it
 * OpenCode stops the agent loop on every rejected ask and the chat sits dead
 * until the user manually prompts "continue".
 *
 * Bash can still slip file access past OpenCode's command parsing, so this
 * reply is NOT what keeps the agent out of the user's personal folders — the
 * macOS seatbelt around the server process is (see sandboxCommand).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- untyped event payload */
function replyToPermission(sessionId: string, permissionId: string, permission: string, ask: any): void {
  if (!server) return
  const srv = server
  let response: 'always' | 'reject' = 'always'
  let feedback: string | undefined
  if (permission === 'external_directory') {
    // The ask names the directories involved: bash asks carry
    // metadata.directories, file-tool asks metadata.parentDir, and both carry
    // "<dir>/*" patterns. An ask we can't extract a directory from fails
    // closed (reject), same as the old blanket behavior.
    const meta = ask?.metadata ?? {}
    const dirs: string[] = (
      Array.isArray(meta.directories) && meta.directories.length
        ? meta.directories
        : typeof meta.parentDir === 'string' && meta.parentDir
          ? [meta.parentDir]
          : Array.isArray(ask?.patterns)
            ? ask.patterns.map((p: unknown) => String(p).replace(/[\\/]\*$/, ''))
            : []
    ).map(String)
    const inTemp = dirs.length > 0 && dirs.every((d) => TEMP_ROOTS.some((root) => isUnderRoot(d, root)))
    if (!inTemp) {
      response = 'reject'
      feedback =
        `${dirs.join(', ') || 'That path'} is outside the project directory and off-limits. ` +
        'Work only inside the project (the OS temp dir is fine for scratch files). ' +
        'Game screenshots are already saved in-project under .genieengine/test-shots/ and ' +
        'user-attached files (images, zips, asset folders) under .genieengine/attachments/ — ' +
        'read them from there instead of copying.'
    }
  }
  void (async () => {
    try {
      // Newer reply route: a rejection can carry feedback, which reaches the
      // model as the tool error text so it can route around the denial.
      await api(srv, 'POST', `/permission/${permissionId}/reply`, { reply: response, message: feedback })
    } catch {
      // Older servers only have the session route (feedback not supported).
      await api(srv, 'POST', `/session/${sessionId}/permissions/${permissionId}`, { response }).catch(() => {})
    }
  })()
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function handleEvent(evt: any): void {
  const props = evt?.properties ?? {}
  if (evt?.type === 'permission.asked' && props.id && props.sessionID) {
    replyToPermission(props.sessionID, props.id, String(props.permission ?? ''), props)
  } else if (evt?.type === 'permission.v2.asked' && props.id && props.sessionID) {
    replyToPermission(props.sessionID, props.id, String(props.action ?? ''), props)
  } else if (
    (evt?.type === 'question.asked' || evt?.type === 'question.v2.asked') &&
    props.id &&
    props.sessionID === sessionID
  ) {
    // The "question" tool blocks the whole turn until it gets a reply — the
    // renderer shows the options as buttons (see ChatPanel's question card).
    // Both API generations carry identical payloads (id/sessionID/questions),
    // same v1/v2 dance as the permission events above.
    sendToRenderer('chat:question', { id: props.id, questions: props.questions ?? [] })
  } else if (/^question\.(v2\.)?(replied|rejected)$/.test(evt?.type) && props.requestID) {
    sendToRenderer('chat:question-done', props.requestID)
  } else if (evt?.type === 'message.updated' && props.info?.id) {
    messageMeta.set(props.info.id, { role: props.info.role, agent: props.info.agent })
  } else if (evt?.type === 'message.part.updated') {
    if (!sessionID || !props.part) return
    if (props.sessionID === sessionID) {
      // The user's own message echoes back as a text part — skip it.
      if (messageMeta.get(props.part.messageID)?.role === 'user') return
      const update = translatePart(props.part)
      if (update) {
        if (update.kind === 'text' || update.kind === 'reasoning') partCache.set(update.partID, update)
        sendToRenderer('chat:part', update)
      }
    } else {
      // Subagent sessions (task-tool children) used to stream nothing: the
      // game-tester would probe for 10+ minutes behind a perfectly still
      // chat, and users read the silence as a hang and cancelled the turn.
      // Relay their tool calls — labelled, tools only; their text/reasoning
      // belongs to the subagent's own report, not the main transcript.
      const agent = messageMeta.get(props.part.messageID)?.agent
      if (agent !== GAME_TESTER_AGENT) return
      const update = translatePart(props.part)
      if (update?.kind === 'tool' && update.tool) {
        sendToRenderer('chat:part', { ...update, tool: { ...update.tool, agent } })
      }
    }
  } else if (evt?.type === 'message.part.delta') {
    if (!sessionID || props.sessionID !== sessionID || props.field !== 'text') return
    const cached = partCache.get(props.partID)
    if (!cached) return // part not announced (or not a streaming kind) — skip
    cached.text = (cached.text ?? '') + String(props.delta ?? '')
    sendToRenderer('chat:part', { ...cached })
  } else if (evt?.type === 'file.edited') {
    // The agent touched a project file — nudge the Files/Git panels (debounced).
    if (filesChangedTimer) clearTimeout(filesChangedTimer)
    filesChangedTimer = setTimeout(() => sendToRenderer('chat:files-changed'), 750)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Consume the server's SSE event stream via node:http — undici's fetch
 * applies a 5-minute idle body timeout that would silently kill the stream
 * during long agent "thinking" gaps. Reconnects while the server lives.
 */
function pumpEvents(srv: OpencodeServer): void {
  if (srv.sseAbort.signal.aborted) return
  const req = httpGet(`${srv.base}/event`, { signal: srv.sseAbort.signal, timeout: 0 }, (res) => {
    res.setEncoding('utf8')
    let buffer = ''
    res.on('data', (chunk: string) => {
      buffer += chunk
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        try {
          handleEvent(JSON.parse(dataLine.slice(5)))
        } catch {
          /* malformed frame — skip */
        }
      }
    })
    res.on('end', () => retry())
    res.on('error', () => retry())
  })
  req.on('error', () => retry())

  const retry = (): void => {
    if (!srv.sseAbort.signal.aborted && srv.proc.exitCode === null) {
      setTimeout(() => pumpEvents(srv), 1000)
    }
  }
}

/** Quote a path as an SBPL string literal. */
function sbplPath(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** A path plus its symlink-resolved form (seatbelt matches canonical paths). */
function withRealpath(p: string): string[] {
  try {
    const real = realpathSync(p)
    return real === p ? [p] : [p, real]
  } catch {
    return [p]
  }
}

/**
 * The .app bundle holding the running executable (macOS layout is always
 * <bundle>.app/Contents/MacOS/<binary>). Falls back to the binary's own
 * directory if the executable somehow isn't in a bundle — never a broad
 * ancestor, since this feeds a sandbox allow-rule.
 */
function appBundleRoot(): string {
  const bundle = dirname(dirname(dirname(process.execPath)))
  return bundle.endsWith('.app') ? bundle : dirname(process.execPath)
}

/** Every ancestor directory of p, from dirname(p) up to the filesystem root. */
function ancestorDirs(p: string): string[] {
  const out: string[] = []
  for (let dir = dirname(p); ; dir = dirname(dir)) {
    out.push(dir)
    if (dir === dirname(dir)) break
  }
  return out
}

/**
 * Wraps the chat-server command in a macOS seatbelt sandbox, inherited by
 * every tool it spawns (bash, rg, git, the MCP bridge). Two reasons:
 *
 *  - macOS attributes file access by this process tree to GenieEngine, so a
 *    stray `find ~` from the model used to pop "GenieEngine would like to
 *    access your Desktop/Photos/…" TCC dialogs at the user. Seatbelt denies
 *    the access before TCC is ever consulted — no dialog, the command just
 *    gets a permission error the agent can read and route around.
 *  - OpenCode's external-directory permission asks are parsed out of bash
 *    commands heuristically and can miss, so replyToPermission alone can't
 *    keep the agent out of personal folders. This is the hard boundary.
 *
 * The profile allows everything except the user's personal and cloud-synced
 * folders plus key credential stores. The project itself is re-allowed even
 * when it lives inside a denied folder (projects commonly sit in Documents;
 * SBPL is last-match-wins), and the app's own files stay readable — the
 * opencode binary, MCP bridge, and dev vendor tree live there.
 *
 * "The app's own files" must cover the WHOLE bundle, not just Resources:
 * OpenCode spawns the MCP bridge with the app's own executable
 * (Contents/MacOS, loading Contents/Frameworks), and when the app runs from
 * a DMG mounted under /Volumes — a denied root — the bridge died at dyld
 * time, silently taking every genieengine game tool with it ("server
 * unavailable key=genieengine" in the OpenCode log). Electron startup also
 * canonicalizes its own bundle path, stat'ing each ancestor directory
 * (/Volumes, the mount root), so those need metadata-level reads too or ICU
 * init crashes before main(). Metadata only — denied directories still can't
 * be listed or read.
 */
function sandboxCommand(opencode: string, args: string[], projectPath: string): { command: string; args: string[] } {
  if (process.platform !== 'darwin') return { command: opencode, args }
  const home = homedir()
  const denyDirs = [
    app.getPath('desktop'),
    app.getPath('documents'),
    app.getPath('downloads'),
    app.getPath('music'),
    app.getPath('pictures'), // includes the Photos library
    app.getPath('videos'),
    join(home, 'Library', 'Mobile Documents'), // iCloud Drive
    join(home, 'Library', 'CloudStorage'), // Google Drive / Dropbox / OneDrive mounts
    join(home, 'Library', 'Containers'),
    join(home, 'Library', 'Group Containers'),
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    '/Volumes' // removable + network drives
  ]
  // The MCP bridge reads harness.json from userData, so that directory stays
  // readable — but the asset-generation API keys stored next to it don't.
  const denyFiles = [
    join(app.getPath('userData'), 'gptimage-credentials.json'),
    join(app.getPath('userData'), 'hy3d-credentials.json')
  ]
  const allowRead = [
    ...withRealpath(app.getAppPath()),
    ...withRealpath(process.resourcesPath),
    ...withRealpath(appBundleRoot()),
    dirname(opencode)
  ]
  const allowReadWrite = withRealpath(projectPath)
  // Ancestors of every allowed path (deduped), covering path canonicalization
  // through denied roots — e.g. /Volumes and the mount root for a DMG-run
  // app, or an external volume holding the project.
  const allowStat = [...new Set([...allowRead, ...allowReadWrite].flatMap(ancestorDirs))]
  const profile = [
    '(version 1)',
    '(allow default)',
    `(deny file-read* file-write* ${denyDirs.map((p) => `(subpath ${sbplPath(p)})`).join(' ')})`,
    `(deny file-read* ${denyFiles.map((p) => `(literal ${sbplPath(p)})`).join(' ')})`,
    `(allow file-read* ${allowRead.map((p) => `(subpath ${sbplPath(p)})`).join(' ')})`,
    `(allow file-read* file-write* ${allowReadWrite.map((p) => `(subpath ${sbplPath(p)})`).join(' ')})`,
    `(allow file-read-metadata ${allowStat.map((p) => `(literal ${sbplPath(p)})`).join(' ')})`
  ].join('\n')
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, opencode, ...args] }
}

/** Kill the serve process (if any) without touching conversation state. */
function killServer(): void {
  if (server) {
    server.sseAbort.abort()
    server.proc.kill()
    server = null
  }
}

async function ensureServer(projectPath: string): Promise<OpencodeServer> {
  if (server && server.projectPath === projectPath && server.proc.exitCode === null) {
    return server
  }
  // Replace a dead or wrong-project server process — but never reset the
  // conversation here: sessions live in OpenCode's storage, not the process,
  // and a session restored from saved chat history must survive its own
  // first send (which is what spawns the server).
  killServer()

  const opencode = await resolveOpencode()
  if (!opencode) {
    throw new Error(
      'The bundled OpenCode assistant is missing. Reinstall GenieEngine, or run `npm run setup` in development.'
    )
  }

  const port = await getFreePort()
  // The MCP bridge inherits this env through OpenCode, so the game-test tools
  // reach THIS app instance even when several GenieEngine instances are running
  // (harness.json alone is shared and only names whichever registered last).
  const harness = getHarnessEndpoint()
  // Same multi-instance problem one level up: the global config's
  // mcp.genieengine command names the binary of whichever instance STARTED
  // last, which this instance's sandbox usually can't read (and which is gone
  // entirely once its DMG is ejected). OPENCODE_CONFIG_CONTENT merges over
  // the file config at server startup — objects merge, arrays replace — so
  // the spawned server always runs this instance's own bridge while the
  // user's other config keys survive.
  const mcpEntry = genieengineMcpEntry()
  // The app-owned build rules ride the same per-spawn override. `instructions`
  // is the one config key whose arrays concatenate across layers instead of
  // replacing, so this adds to whatever the user configured globally.
  const instructions = agentInstructionsPath()
  const configContent = {
    ...(mcpEntry ? { mcp: { genieengine: mcpEntry } } : {}),
    ...(instructions ? { instructions: [instructions] } : {})
  }
  const { command, args } = sandboxCommand(
    opencode,
    ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    projectPath
  )
  const proc = spawn(command, args, {
    cwd: projectPath,
    // PWD must match cwd — OpenCode trusts the logical PWD for its project
    // directory (see the run-mode bug this fixed in git history).
    // OPENCODE_ENABLE_EXA registers the websearch tool (hosted Exa/Parallel
    // search, no API key needed) — without it, OpenCode only offers webfetch.
    env: {
      ...process.env,
      PWD: projectPath,
      NO_COLOR: '1',
      OPENCODE_ENABLE_EXA: '1',
      ...(harness
        ? { GENIEENGINE_HARNESS_PORT: String(harness.port), GENIEENGINE_HARNESS_TOKEN: harness.token }
        : {}),
      ...(Object.keys(configContent).length
        ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent) }
        : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const srv: OpencodeServer = {
    proc,
    base: `http://127.0.0.1:${port}`,
    projectPath,
    stderrTail: '',
    sseAbort: new AbortController()
  }
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    srv.stderrTail = (srv.stderrTail + chunk).slice(-2000)
  })
  proc.once('exit', () => {
    if (server === srv) server = null
  })

  await waitForHealth(srv)
  server = srv
  pumpEvents(srv)
  return srv
}

/** API failure carrying the HTTP status, so callers can tell 404 from flake. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

/**
 * API call via node:http with timeouts disabled: the message POST blocks for
 * the entire agent run, which can far exceed undici fetch's 5-minute default.
 */
function api<T>(srv: OpencodeServer, method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${srv.base}${path}`,
      { method, headers: { 'content-type': 'application/json' }, timeout: 0 },
      (res) => {
        res.setEncoding('utf8')
        let data = ''
        res.on('data', (chunk: string) => (data += chunk))
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(
              new ApiError(
                `OpenCode API ${method} ${path} failed (${res.statusCode}): ${data.slice(0, 300)}`,
                res.statusCode
              )
            )
            return
          }
          try {
            resolve(JSON.parse(data) as T)
          } catch {
            reject(new Error(`OpenCode API ${method} ${path}: invalid JSON response`))
          }
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

/**
 * The most common first-run failure is a configured model whose provider has
 * no credentials (OpenCode then 500s with an opaque "UnknownError"). Check
 * proactively — both chat models (the dropdown can route any message to
 * either, and the game-tester subagent inherits the turn's model) plus any
 * model pinned on an agent in the user's own config — and explain exactly
 * how to fix it.
 */
async function assertProviderAvailable(srv: OpencodeServer): Promise<void> {
  if (srv.providerChecked) return
  let missing: string | null = null
  try {
    const config = await api<{ model?: string; agent?: Record<string, { model?: string }> }>(
      srv,
      'GET',
      '/config'
    )
    const wanted = new Set<string>()
    for (const ref of [config.model, ...Object.values(config.agent ?? {}).map((a) => a?.model)]) {
      if (typeof ref === 'string' && ref.includes('/')) wanted.add(ref.split('/')[0])
    }
    for (const tier of ['medium', 'large'] as const) {
      wanted.add((await resolveChatModel(tier)).providerID)
    }
    if (wanted.size) {
      const list = await api<{ providers: { id: string }[] }>(srv, 'GET', '/config/providers')
      const available = new Set(list.providers.map((p) => p.id))
      missing = [...wanted].find((id) => !available.has(id)) ?? null
    }
  } catch {
    return // Introspection failed — don't block the chat on it.
  }
  if (missing) {
    // The settings panel writes keys for every provider we configure
    // (including the `medium`/`large` openai-compatible ones, which
    // `opencode auth login` has no named entry for) — point users there.
    throw new Error(
      `The AI provider "${missing}" isn't connected yet — its API key is missing.\n\n` +
        `Open the AI settings (gear icon in the sidebar) and add the API key for its endpoint, then try again.`
    )
  }
  srv.providerChecked = true
}

/**
 * Whether a saved session id no longer exists on the server. Only an explicit
 * 404/410 counts: forgetting the session on ANY failure (as this used to do)
 * silently forked the conversation into a fresh context-less session whenever
 * the GET merely flaked, which users experienced as the assistant "losing its
 * memory" after reopening a project. Transient failures are retried, then
 * surfaced as a send error — the user can retry with the session intact.
 */
async function sessionGone(srv: OpencodeServer, id: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await api(srv, 'GET', `/session/${id}`)
      return false
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return true
      if (attempt >= 2) {
        throw new Error(
          `Could not verify the saved conversation (${err instanceof Error ? err.message : err}). Try again.`
        )
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }
}

/** First actual use of a session id restored from saved chat history: drop it if the server no longer has it. */
async function verifyRestoredSession(srv: OpencodeServer): Promise<void> {
  if (sessionID && sessionRestored) {
    sessionRestored = false
    if (await sessionGone(srv, sessionID)) sessionID = null
  }
}

/**
 * Provider errors that mean the accumulated conversation no longer fits the
 * model's context window (observed: "Input length 202850 exceeds the maximum
 * allowed input length of 202720 tokens"; also matches the OpenAI/Anthropic
 * phrasings). Once a session hits this, EVERY further send into it fails the
 * same way — the only way forward is a fresh session, re-seeded with a recap.
 */
const CONTEXT_OVERFLOW_RE =
  /context[_ -]?(length|window)|maximum (allowed )?(input|context|prompt)|input (length|is )?too long|prompt is too long|input length \d+ exceeds|too many (total )?(text bytes|input tokens)/i

/**
 * Provider/infra failures that tend to clear on their own within seconds:
 * backend 5xx, gateway trouble, capacity. Observed live from an
 * OpenAI-compatible endpoint mid-turn: "HTTP 500: Internal server error
 * Failed to find a worker for remote generation." and "HTTP 500: … Error in
 * kv cache transfer for generation requests (executor rank: 1)". Unlike
 * context overflow these leave the session perfectly healthy — the agent
 * loop just stopped — so the recovery is to resume the SAME session, never
 * to roll over.
 */
const TRANSIENT_PROVIDER_RE =
  /HTTP (5\d\d|429)|internal server error|bad gateway|too many requests|overloaded|service unavailable|temporarily unavailable|failed to find a worker|kv cache/i

/** Backoff before each automatic resume of a transiently-failed turn. */
const TRANSIENT_RETRY_DELAYS_MS = [2000, 8000]

/**
 * What the model sees when its turn is resumed after a transient provider
 * error. A user-role message, like the recap: the renderer never displays
 * user-message echoes, so the user sees one seamless turn.
 */
const RESUME_NUDGE =
  '[Your previous response was cut off by a temporary provider error, not by the user. ' +
  'Continue exactly where you left off — do not restart the task or repeat work that already completed.]'

/**
 * Validates and kicks off a chat turn. Resolves as soon as the request is
 * accepted; progress streams via chat:part events and completion (or failure)
 * arrives as a chat:done event when the blocking POST returns.
 *
 * `tier` picks which chat model answers this message. It rides the message
 * POST as an explicit model override, so switching tiers mid-conversation
 * keeps the same session — the model changes, the history doesn't.
 *
 * `isRetry` marks the internal second attempt after a context-overflow
 * rollover: it keeps the turn claimed (busy stays true, so the renderer sees
 * one seamless turn) and must never recurse again.
 */
export async function sendChatMessage(
  message: string,
  projectPath: string,
  attachments: ChatAttachment[] = [],
  tier: ChatModelTier = 'medium',
  isRetry = false
): Promise<void> {
  if (!isRetry) {
    if (busy) throw new Error('A response is already in progress')
    // Claim the turn before the first await — two rapid sends could otherwise
    // both pass the guard above while the first was still starting its server.
    busy = true
    cancelled = false
  }

  let srv: OpencodeServer
  let uploaded: SavedUpload[] = []
  let recap: string | null = null
  try {
    srv = await ensureServer(projectPath)
    await assertProviderAvailable(srv)
    // A session restored from a saved chat continues that conversation (OpenCode
    // persists sessions per directory) — verified against the server the first
    // time it is actually used.
    await verifyRestoredSession(srv)
    if (!sessionID) {
      // Starting a fresh session while the project still has a saved
      // transcript (stale/lost session id, or the context-overflow rollover
      // below): seed it with a recap of that transcript. The chat window and
      // the model must not diverge — this is what carries the conversation
      // the user can see back into the new OpenCode session. After /clear
      // there is no saved transcript, so a cleared chat correctly starts raw.
      recap = await loadTranscriptRecap(projectPath).catch(() => null)
      const session = await api<{ id: string }>(srv, 'POST', '/session', {})
      sessionID = session.id
    }
    // Asset uploads (zips, folders, models…) are copied into the project's
    // .genieengine/attachments/ — the only place the sandboxed assistant can
    // reach them. Unlike the best-effort image saving below, a failure here
    // fails the whole send: the message must not describe files that never
    // arrived. The error text is user-readable (caps, unreadable source).
    // Copied after the session checks so a failed verify can't duplicate them.
    uploaded = await saveChatUploads(projectPath, attachments.filter((a) => a.path))
  } catch (err) {
    busy = false
    throw err
  }

  // Parts of finished turns are final — only the live turn needs delta state.
  partCache.clear()
  const currentSession = sessionID
  // The chat model for this turn, resolved now so a mid-turn settings save
  // can't split one turn across models (the resume nudges reuse it too).
  const model = await resolveChatModel(tier)

  // Image attachments ride the message as file parts (every chat model must
  // accept image input, see opencode-setup.ts) AND are saved under
  // .genieengine/attachments/ with their paths appended: a path is how the
  // model gets back to a reference image in later turns (the read tool
  // returns image files as attachments) and how the game-tester subagent —
  // which never sees the parent's message — can compare a screenshot against
  // it. Best-effort — a failed save just means the message goes out the old
  // way.
  // The recap rides inside this message rather than as its own turn: a
  // separate priming message would cost a full model round-trip. The renderer
  // shows its own copy of the user text, so the recap never appears in the UI.
  let text = recap ? `${recap}\n\n${message}` : message
  const images = attachments.filter((a) => a.dataUrl && a.mime.startsWith('image/'))
  if (images.length) {
    const saved = await saveChatAttachments(projectPath, images).catch(() => [] as string[])
    if (saved.length) {
      text +=
        `\n\n[The attached image${saved.length > 1 ? 's are' : ' is'} also saved at: ` +
        `${saved.join(', ')} — re-read ${saved.length > 1 ? 'these paths' : 'this path'} ` +
        'whenever you need another look, and hand it to the game-tester to compare against.]'
    }
  }
  // Asset uploads reach the model as paths only (copied above) — a zip or a
  // 40 MB GLB as a base64 message part would be useless to it. The note also
  // spells out the .genieengine/ catch: Godot ignores that directory, so assets
  // must be copied into the game tree to be usable.
  if (uploaded.length) {
    const list = uploaded.map((u) => (u.dir ? `${u.rel}/ (folder)` : u.rel)).join(', ')
    text +=
      `\n\n[The user uploaded asset file${uploaded.length > 1 ? 's' : ''} with this message, ` +
      `saved in the project at: ${list}. Explore what's inside — extract any .zip first ` +
      '(e.g. `unzip -o <file>.zip -d <folder>`). Everything under .genieengine/ is invisible ' +
      'to Godot, so copy the files the game needs into the proper assets/ sub-folders ' +
      'before wiring them into scenes.]'
  }

  // Inline attachments travel as data-URL file parts in the message itself —
  // they reach the model directly when it supports image input.
  const parts: unknown[] = attachments
    .filter((a) => a.dataUrl)
    .map((a) => ({
      type: 'file',
      mime: a.mime,
      filename: a.name,
      url: a.dataUrl
    }))
  parts.push({ type: 'text', text })

  void (async () => {
    // Set when the turn died to context overflow and a rollover retry should
    // run: the retry happens in `finally` so this attempt's api/renderer work
    // is fully settled first, and `busy` stays claimed across the handoff so
    // the renderer experiences one seamless turn.
    let retryInFreshSession = false
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any -- untyped server reply */
      const turnError = (reply: any): string | null => {
        const error = reply?.info?.error
        return error ? String(error?.data?.message || error?.name || JSON.stringify(error)) : null
      }
      // A transient backend failure (TRANSIENT_PROVIDER_RE) kills the agent
      // loop mid-turn, but everything up to it — applied edits, tool results —
      // is safely in the session. Resume the same session with a nudge rather
      // than surfacing the error: re-sending the user message would duplicate
      // it, and a fresh session would orphan the completed work. Bounded, so
      // a provider that is genuinely down still surfaces its error after a
      // couple of attempts instead of retrying forever.
      let reply: any
      for (let attempt = 0; ; attempt++) {
        reply = await api<any>(srv, 'POST', `/session/${currentSession}/message`, {
          model,
          parts: attempt ? [{ type: 'text', text: RESUME_NUDGE }] : parts
        })
        const detail = turnError(reply)
        if (
          detail === null ||
          !TRANSIENT_PROVIDER_RE.test(detail) ||
          attempt >= TRANSIENT_RETRY_DELAYS_MS.length ||
          cancelled
        ) {
          break
        }
        console.warn(`[genieengine] transient provider error, resuming turn (attempt ${attempt + 1}):`, detail)
        await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAYS_MS[attempt]))
        if (cancelled) break
      }
      const detail = turnError(reply)
      /* eslint-enable @typescript-eslint/no-explicit-any */
      // The conversation no longer fits the model's context window; nothing
      // sent into this session can ever succeed again. Roll over: next
      // session starts fresh and loadTranscriptRecap carries the visible
      // conversation into it. Without this, users were stuck resending into
      // a permanently failing session until they gave up and lost context.
      if (detail !== null && CONTEXT_OVERFLOW_RE.test(detail)) {
        sessionID = null
        if (!isRetry && !cancelled) {
          retryInFreshSession = true
          return
        }
      }
      // Re-send the final parts: guarantees the full text is present even if
      // the last SSE frames raced the POST response.
      for (const part of reply?.parts ?? []) {
        const update = translatePart(part)
        if (update) sendToRenderer('chat:part', update)
      }
      if (cancelled) {
        sendToRenderer('chat:done', { ok: false, cancelled: true })
      } else if (detail !== null) {
        sendToRenderer('chat:done', {
          ok: false,
          error: CONTEXT_OVERFLOW_RE.test(detail)
            ? `This message is too large for the model's context window even in a fresh session — ` +
              `try a shorter message or smaller attachments. (${detail})`
            : detail
        })
      } else {
        sendToRenderer('chat:done', { ok: true })
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      // Overflow surfaced as a failed request rather than an errored reply:
      // still roll over so the NEXT send starts a recap-seeded session, but
      // don't auto-retry — the POST may have half-landed, and a duplicate
      // user message is worse than asking for a resend.
      if (CONTEXT_OVERFLOW_RE.test(detail)) sessionID = null
      sendToRenderer('chat:done', {
        ok: false,
        cancelled,
        error: cancelled ? undefined : detail
      })
    } finally {
      if (retryInFreshSession) {
        void sendChatMessage(message, projectPath, attachments, tier, true).catch((err) => {
          // The retry failed before its own turn could report — close out the
          // renderer's pending turn here or the chat would spin forever.
          sendToRenderer('chat:done', {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
          busy = false
        })
      } else {
        busy = false
      }
    }
  })()
}

export function cancelChat(): void {
  if (busy && server && sessionID) {
    cancelled = true
    void fetch(`${server.base}/session/${sessionID}/abort`, { method: 'POST' }).catch(() => {})
  }
}

/*
 * /undo and /redo — OpenCode's native session revert. Reverting to a user
 * message hides that turn and everything after it from the model AND restores
 * the project files to the snapshot OpenCode took before the turn ran;
 * unrevert restores the pre-revert state (the revert record keeps its own
 * snapshot for that). The revert point lives on the session, so it survives
 * app restarts — but sending a new message makes the pending revert permanent
 * (OpenCode trims the reverted messages), which is why redo availability is
 * additionally tracked renderer-side.
 */

/**
 * The session's real user turns (message ids, ascending). Excludes the
 * synthetic user-role prompts this module injects (RESUME_NUDGE, sent to
 * resume a turn after a transient provider error): those belong to the turn
 * of the real user message before them, so a revert must never target one —
 * it would restore half a turn.
 */
async function listUserTurns(srv: OpencodeServer, session: string): Promise<string[]> {
  /* eslint-disable @typescript-eslint/no-explicit-any -- untyped server JSON */
  const entries = await api<any[]>(srv, 'GET', `/session/${session}/message`)
  const ids: string[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const info = entry?.info
    if (info?.role !== 'user' || typeof info.id !== 'string') continue
    const parts = Array.isArray(entry.parts) ? entry.parts : []
    if (parts.some((p: any) => p?.type === 'text' && p.text === RESUME_NUDGE)) continue
    ids.push(info.id)
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return ids.sort()
}

/** The session's pending revert point, if any (set by a previous undo). */
async function revertPoint(srv: OpencodeServer, session: string): Promise<string | null> {
  const info = await api<{ revert?: { messageID?: string } }>(srv, 'GET', `/session/${session}`)
  return info.revert?.messageID ?? null
}

/**
 * The session undo/redo operate on, or null when there is no conversation
 * (no session yet, or the saved id is gone from the server). Never creates a
 * session — unlike a send, an undo must not open a fresh conversation.
 */
async function activeSession(projectPath: string): Promise<{ srv: OpencodeServer; session: string } | null> {
  if (!sessionID) return null
  const srv = await ensureServer(projectPath)
  await verifyRestoredSession(srv)
  return sessionID ? { srv, session: sessionID } : null
}

/** Wait for an aborted turn to settle (release `busy`) before reverting under it. */
async function waitForIdle(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  return !busy
}

/**
 * /undo: revert the conversation to just before its most recent user turn
 * (or one turn further back on repeat), restoring the files that turn
 * touched. Returns the reverted-to message id so the renderer can drop the
 * matching turns from its own transcript — the renderer's assistant message
 * ids ARE OpenCode message ids, which is what makes that mapping possible.
 */
export async function undoChat(projectPath: string): Promise<{ revertedTo: string }> {
  // Undoing a turn that is still streaming aborts it first (matching the
  // native TUI), then reverts once the in-flight POST has settled.
  if (busy) {
    cancelChat()
    if (!(await waitForIdle(8000))) {
      throw new Error('Could not stop the current response — press Stop, then try again.')
    }
  }
  const active = await activeSession(projectPath)
  if (!active) throw new Error('Nothing to undo.')
  const { srv, session } = active
  busy = true // hold the turn so a racing send can't interleave with the revert
  try {
    const point = await revertPoint(srv, session)
    const target = (await listUserTurns(srv, session)).filter((id) => !point || id < point).pop()
    if (!target) throw new Error('Nothing to undo.')
    await api(srv, 'POST', `/session/${session}/revert`, { messageID: target })
    return { revertedTo: target }
  } finally {
    busy = false
  }
}

/**
 * /redo: step the revert point forward one user turn, or fully restore the
 * conversation and files once the newest undone turn is reached (unrevert).
 */
export async function redoChat(projectPath: string): Promise<void> {
  if (busy) throw new Error('A response is already in progress')
  const active = await activeSession(projectPath)
  if (!active) throw new Error('Nothing to redo.')
  const { srv, session } = active
  busy = true
  try {
    const point = await revertPoint(srv, session)
    if (!point) throw new Error('Nothing to redo.')
    const next = (await listUserTurns(srv, session)).find((id) => id > point)
    if (next) await api(srv, 'POST', `/session/${session}/revert`, { messageID: next })
    else await api(srv, 'POST', `/session/${session}/unrevert`, {})
  } finally {
    busy = false
  }
}

/**
 * A request is owned by whichever question-API generation created it, and the
 * event doesn't say which — answer via the v1 route, falling back to v2.
 */
async function questionAction(requestID: string, action: 'reply' | 'reject', body: unknown): Promise<void> {
  if (!server) throw new Error('The assistant is not running.')
  try {
    await api(server, 'POST', `/question/${requestID}/${action}`, body)
  } catch {
    await api(server, 'POST', `/api/session/${sessionID}/question/${requestID}/${action}`, body)
  }
}

/** Deliver the user's answers for a pending question (unblocks the turn). */
export async function answerQuestion(requestID: string, answers: string[][]): Promise<void> {
  await questionAction(requestID, 'reply', { answers })
}

/** Dismiss a pending question — best-effort; the tool reports the dismissal to the model. */
export async function rejectQuestion(requestID: string): Promise<void> {
  if (!server) return
  await questionAction(requestID, 'reject', {}).catch(() => {})
}

/**
 * Questions still awaiting an answer in the current session. Lets a freshly
 * (re)loaded window re-show the question card instead of leaving the turn
 * stuck on a prompt that's no longer on screen.
 */
export async function pendingQuestion(): Promise<{ id: string; questions: unknown[] } | null> {
  if (!server || !sessionID) return null
  /* eslint-disable @typescript-eslint/no-explicit-any -- untyped server JSON */
  const v1 = await api<any[]>(server, 'GET', '/question').catch(() => [])
  const v2 = await api<{ data?: any[] }>(server, 'GET', `/api/session/${sessionID}/question`).catch(
    () => ({}) as { data?: any[] }
  )
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const mine = [...(Array.isArray(v1) ? v1 : []), ...(v2.data ?? [])].find(
    (r) => r?.sessionID === sessionID && r?.id
  )
  return mine ? { id: mine.id, questions: mine.questions ?? [] } : null
}

/** Start a fresh conversation in the same project (keeps the server warm). */
export function newChatSession(): void {
  cancelChat()
  sessionID = null
  sessionRestored = false
}

/**
 * Continue a session saved in the project's chat history (called when a
 * project with a restored transcript is opened). Verified lazily on the next
 * send — see sendChatMessage. A null id is ignored rather than applied: it
 * means the chat file is missing or unreadable, and wiping a live session
 * over that (e.g. on a window reload whose loadState found nothing) would
 * silently fork the conversation. Real resets go through newChatSession
 * (/clear) or shutdownChat (project switch).
 */
export function resumeSession(id: string | null): void {
  if (busy || !id) return
  sessionID = id
  sessionRestored = true
}

/** The active conversation id, saved with the transcript for later resume. */
export function getSessionID(): string | null {
  return sessionID
}

/** Tear down the chat server — project switch or app quit. */
export function shutdownChat(): void {
  sessionID = null
  sessionRestored = false
  busy = false
  messageMeta.clear()
  partCache.clear()
  killServer()
}
