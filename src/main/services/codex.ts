import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { sendToRenderer } from '../window'
import { resolveCodex } from './binaries'
import { loadTranscriptRecap, saveChatAttachments, saveChatUploads, type SavedUpload } from './chat-history'
import { sandboxCommand } from './chat-sandbox'
import { resolveChatSlot } from './chat-setup'
import { codexConfigOverrides, codexHome, PROXY_TOKEN_ENV } from './codex-config'
import { itemToPart, type CodexItem, type CodexTurn } from './codex-items'
import { CodexRpc, RpcError, type RpcId } from './codex-rpc'
import { ensureModelProxy, lastUpstreamFailure } from './model-proxy'
import { captureSnapshot, loadUndoState, restoreSnapshot, saveUndoState } from './snapshots'
import { getHarnessEndpoint } from './test-harness'
import type { ChatAttachment, ChatModelTier, ChatPartUpdate, ChatQuestionRequest } from '../../shared/types'

/**
 * AI chat backed by OpenAI's Codex, run as `codex-app-server` — the
 * JSON-RPC-over-stdio server Codex's IDE integrations use.
 *
 * One app-server process runs per open project (it lives inside a sandbox
 * profile scoped to that project, see chat-sandbox.ts). The conversation is a
 * Codex thread, persisted in GenieEngine's CODEX_HOME so a reopened project
 * continues it. Each message is a turn: progress streams in as item
 * notifications — text and reasoning deltas, shell commands, file edits, MCP
 * tool calls, subagent activity — so long agentic tasks show real activity
 * instead of a silent spinner, and turn/completed settles the outcome.
 *
 * Model requests don't go to the provider directly: Codex is pointed at the
 * local model proxy (model-proxy.ts), and each turn names its chat slot
 * ('medium' | 'large') as the model.
 */

interface CodexServer {
  proc: ChildProcess
  rpc: CodexRpc
  projectPath: string
  stderrTail: string
  /** Threads this process has started or resumed (others must be resumed before use). */
  loaded: Set<string>
}

let server: CodexServer | null = null
let starting: { projectPath: string; promise: Promise<CodexServer> } | null = null
/** The conversation's Codex thread id (persisted with the transcript as its session id). */
let threadId: string | null = null
let busy = false
let cancelled = false
/**
 * Bumped by shutdownChat. A turn still settling from the previous project
 * (its server was just killed) must not report into the next project's chat.
 */
let generation = 0
/** The main thread's running turn, while there is one. */
let activeTurn: { threadId: string; turnId: string } | null = null
/** The latest main-thread turn — where subagent chips land once it has finished. */
let lastTurnId: string | null = null
let filesChangedTimer: ReturnType<typeof setTimeout> | null = null

/** Subagent threads of the conversation → the label their tool chips carry (the agent role). */
const childThreads = new Map<string, string>()
/** Each subagent's relayed tool chips (by part id), re-sent once its label is known. */
const childParts = new Map<string, Map<string, ChatPartUpdate>>()
/** Subagent thread → its running turn, so Stop can interrupt delegated work too. */
const childTurns = new Map<string, string>()
/** Resolvers waiting on turn/completed, by turn id (with the server running the turn). */
const turnWaiters = new Map<string, { srv: CodexServer; resolve: (turn: CodexTurn) => void }>()
/** turn/completed that arrived before anyone waited for it (bounded). */
const finishedTurns = new Map<string, CodexTurn>()
/**
 * Accumulated text of streaming parts, by part id: item/started announces an
 * empty item and the characters arrive as deltas, so without this cache text
 * and thinking would not stream at all.
 */
const partCache = new Map<string, ChatPartUpdate>()
/** Open question-card requests, by request id (the tool call's item id). */
const pendingQuestions = new Map<
  string,
  { srv: CodexServer; rpcId: RpcId; questionIds: string[]; request: ChatQuestionRequest }
>()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Kill the app-server (if any) without touching conversation state. */
function killServer(): void {
  if (server) {
    server.proc.kill()
    server = null
  }
}

async function ensureServer(projectPath: string): Promise<CodexServer> {
  if (server && server.projectPath === projectPath && server.proc.exitCode === null) return server
  if (starting?.projectPath === projectPath) return starting.promise
  // Replace a dead or wrong-project process — but never reset the
  // conversation here: threads live in CODEX_HOME, not the process, and a
  // thread restored from saved chat history must survive its own first send
  // (which is what spawns the server).
  killServer()
  const promise = startServer(projectPath).finally(() => {
    if (starting?.promise === promise) starting = null
  })
  starting = { projectPath, promise }
  return promise
}

async function startServer(projectPath: string): Promise<CodexServer> {
  const gen = generation
  const codex = await resolveCodex()
  if (!codex) {
    throw new Error(
      'The bundled Codex assistant is missing. Reinstall GenieEngine, or run `npm run setup` in development.'
    )
  }
  const proxy = await ensureModelProxy()
  // The MCP bridge gets this through its env_vars allowlist, so the game
  // tools reach THIS app instance even when several are running
  // (harness.json alone is shared and only names whichever registered last).
  const harness = getHarnessEndpoint()
  // bin/codex-app-server → the package root, whose codex-path/ and
  // codex-resources/ the server runs helpers from.
  const packageRoot = dirname(dirname(codex))
  const { command, args } = sandboxCommand(codex, codexConfigOverrides(proxy.baseUrl), projectPath, [packageRoot])
  const proc = spawn(command, args, {
    cwd: projectPath,
    env: {
      ...process.env,
      // Keep the logical PWD in step with cwd — shells and tools trust it.
      PWD: projectPath,
      NO_COLOR: '1',
      CODEX_HOME: codexHome(),
      [PROXY_TOKEN_ENV]: proxy.token,
      ...(harness
        ? { GENIEENGINE_HARNESS_PORT: String(harness.port), GENIEENGINE_HARNESS_TOKEN: harness.token }
        : {})
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const srv: CodexServer = { proc, rpc: new CodexRpc(proc), projectPath, stderrTail: '', loaded: new Set() }
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    srv.stderrTail = (srv.stderrTail + chunk).slice(-4000)
  })
  const died = (reason: string): void => {
    srv.rpc.close(new Error(reason))
    if (server === srv) server = null
    // Settle everything that was waiting on this process (a killed previous
    // process can exit while the next one is already running a turn).
    for (const [turnId, waiter] of turnWaiters) {
      if (waiter.srv !== srv) continue
      turnWaiters.delete(turnId)
      waiter.resolve({ id: turnId, status: 'failed', error: { message: reason, codexErrorInfo: 'other' } })
    }
    for (const [id, pending] of pendingQuestions) {
      if (pending.srv !== srv) continue
      pendingQuestions.delete(id)
      sendToRenderer('chat:question-done', id)
    }
  }
  proc.once('error', (err) => died(`The Codex assistant could not start: ${err.message}`))
  proc.once('exit', () => {
    const detail = srv.stderrTail.trim().split('\n').slice(-3).join('\n')
    died(`The Codex assistant stopped unexpectedly${detail ? `: ${detail}` : '.'}`)
  })
  srv.rpc.onNotification = (method, params) => handleNotification(srv, method, params)
  srv.rpc.onRequest = (id, method, params) => handleServerRequest(srv, id, method, params)

  try {
    await Promise.race([
      srv.rpc.request('initialize', {
        clientInfo: { name: 'genieengine', title: 'GenieEngine', version: app.getVersion() },
        capabilities: { experimentalApi: false, requestAttestation: false }
      }),
      sleep(30000).then(() => Promise.reject(new Error('timed out')))
    ])
  } catch (err) {
    proc.kill()
    const detail = srv.stderrTail.trim() || (err instanceof Error ? err.message : String(err))
    throw new Error(`The Codex assistant failed to start: ${detail}`)
  }
  if (gen !== generation) {
    // The project was closed while this server booted — it must not become
    // the live server for whatever is open now.
    proc.kill()
    throw new Error('The project was closed before the assistant finished starting.')
  }
  srv.rpc.notify('initialized')
  server = srv
  return srv
}

/**
 * Subagents (spawn_agent) run as threads of their own, which Codex 0.164
 * announces with no thread/started notification — a child shows up only as
 * the spawn call's receiver and as turns rooted in ours. Its role (the chip
 * label) is read once from the thread itself.
 */
function adoptChildThread(srv: CodexServer, id: unknown): void {
  if (typeof id !== 'string' || id === threadId || childThreads.has(id)) return
  childThreads.set(id, 'subagent')
  void (async () => {
    // A just-spawned thread can't be read until Codex has written its
    // metadata ("failed to read session metadata" while it initializes).
    for (const delay of [0, 300, 1000, 3000, 6000]) {
      await sleep(delay)
      if (!childThreads.has(id)) return
      try {
        const { thread } = await srv.rpc.request<{
          thread?: { agentRole?: string | null; agentNickname?: string | null }
        }>('thread/read', { threadId: id })
        const label = thread?.agentRole || thread?.agentNickname
        if (!label) return
        childThreads.set(id, label)
        // The subagent may have started working before the lookup returned.
        for (const part of childParts.get(id)?.values() ?? []) relayChildPart(id, part)
        return
      } catch {
        // Not readable yet — retry.
      }
    }
  })()
}

function relayChildPart(thread: string, part: ChatPartUpdate): void {
  if (part.tool) sendToRenderer('chat:part', { ...part, tool: { ...part.tool, agent: childThreads.get(thread) } })
}

/* eslint-disable @typescript-eslint/no-explicit-any -- notification payloads are protocol JSON */
function handleNotification(srv: CodexServer, method: string, params: any): void {
  switch (method) {
    case 'turn/started':
      // A turn rooted in the conversation's running turn but on another
      // thread is a subagent working for it.
      if (params.threadId !== threadId && activeTurn && params.turn?.rootTurnId === activeTurn.turnId) {
        adoptChildThread(srv, params.threadId)
      }
      if (childThreads.has(params.threadId)) childTurns.set(params.threadId, params.turn?.id)
      break
    case 'turn/completed': {
      if (childThreads.has(params.threadId)) {
        childTurns.delete(params.threadId)
        break
      }
      const turn = params.turn as CodexTurn
      const waiter = turnWaiters.get(turn.id)
      if (waiter) {
        turnWaiters.delete(turn.id)
        waiter.resolve(turn)
      } else {
        finishedTurns.set(turn.id, turn)
        if (finishedTurns.size > 20) finishedTurns.delete(finishedTurns.keys().next().value!)
      }
      break
    }
    case 'item/started':
    case 'item/completed': {
      const item = params.item as CodexItem | undefined
      if (
        item?.type === 'collabAgentToolCall' &&
        (params.threadId === threadId || childThreads.has(params.threadId)) &&
        Array.isArray(item.receiverThreadIds)
      ) {
        for (const id of item.receiverThreadIds) adoptChildThread(srv, id)
      }
      relayItem(params.threadId, params.turnId, params.item, method === 'item/completed')
      break
    }
    case 'item/agentMessage/delta':
      appendDelta(params, 'text', '')
      break
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      appendDelta(params, 'reasoning', '')
      break
    case 'item/reasoning/summaryPartAdded':
      // A new summary paragraph — keep it apart from the previous one.
      appendDelta({ ...params, delta: '' }, 'reasoning', '\n\n')
      break
    case 'serverRequest/resolved':
      // A question the turn no longer waits on (answered, interrupted, …).
      for (const [id, pending] of pendingQuestions) {
        if (pending.rpcId === params.requestId) {
          pendingQuestions.delete(id)
          sendToRenderer('chat:question-done', id)
        }
      }
      break
    case 'mcpServer/startupStatus/updated':
      if (params.status === 'failed') console.warn('[genieengine] MCP server failed to start:', params.name, params.error)
      break
    case 'configWarning':
      console.warn('[genieengine] Codex config warning:', params.summary)
      break
  }
}

/** Stream one thread item to the chat: the conversation's own items, and subagents' tool calls. */
function relayItem(thread: string, turnId: string, item: CodexItem, completed: boolean): void {
  if (!item) return
  if (thread === threadId) {
    const part = itemToPart(item, turnId, completed)
    if (!part) return
    if (part.kind === 'text' || part.kind === 'reasoning') {
      const cached = partCache.get(part.partID)
      // item/started is empty and a repeat must not clobber streamed deltas;
      // item/completed is authoritative — unless it came back empty (some
      // providers only stream reasoning, never restate it).
      if (cached && (!completed || !part.text)) {
        if (!completed) return
        part.text = cached.text
      }
      partCache.set(part.partID, part)
    }
    sendToRenderer('chat:part', part)
  } else if (childThreads.has(thread)) {
    // Subagent work used to be invisible: the game-tester would probe for
    // minutes behind a perfectly still chat and users read the silence as a
    // hang. Relay its tool calls — labelled, tools only; its text belongs to
    // the report it hands back.
    const messageID = activeTurn?.turnId ?? lastTurnId
    const part = messageID ? itemToPart(item, messageID, completed) : null
    if (part?.kind === 'tool' && part.tool) {
      if (!childParts.has(thread)) childParts.set(thread, new Map())
      childParts.get(thread)!.set(part.partID, part)
      relayChildPart(thread, part)
    }
  }
  if (completed && (item.type === 'fileChange' || item.type === 'commandExecution')) {
    // The agent may have touched project files — nudge the Files/Git panels (debounced).
    if (filesChangedTimer) clearTimeout(filesChangedTimer)
    filesChangedTimer = setTimeout(() => sendToRenderer('chat:files-changed'), 750)
  }
}

function appendDelta(params: any, kind: 'text' | 'reasoning', separator: string): void {
  if (params.threadId !== threadId) return
  const partID = `${params.turnId}:${params.itemId}`
  let cached = partCache.get(partID)
  if (!cached) {
    cached = { messageID: params.turnId, partID, kind, text: '' }
    partCache.set(partID, cached)
  }
  cached.text = (cached.text ? cached.text + separator : '') + String(params.delta ?? '')
  sendToRenderer('chat:part', { ...cached })
}

/**
 * Requests from the server block a turn until answered. With approval policy
 * "never" approvals shouldn't come up at all; if one does, approve it (the
 * agent is autonomous by design and the sandbox is the boundary) rather than
 * leave the turn hanging.
 */
function handleServerRequest(srv: CodexServer, id: RpcId, method: string, params: any): void {
  switch (method) {
    case 'item/tool/requestUserInput': {
      // The question tool blocks the turn until it gets a reply — the
      // renderer shows the options as buttons (see ChatPanel's question card).
      const questions: any[] = Array.isArray(params.questions) ? params.questions : []
      const request: ChatQuestionRequest = {
        id: String(params.itemId ?? id),
        questions: questions.map((q) => ({
          question: String(q.question ?? ''),
          header: String(q.header ?? ''),
          options: Array.isArray(q.options) ? q.options : [],
          multiple: false,
          custom: Boolean(q.isOther)
        }))
      }
      pendingQuestions.set(request.id, { srv, rpcId: id, questionIds: questions.map((q) => String(q.id)), request })
      sendToRenderer('chat:question', request)
      return
    }
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return srv.rpc.respond(id, { decision: 'accept' })
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return srv.rpc.respond(id, { decision: 'approved' })
    case 'mcpServer/elicitation/request':
      return srv.rpc.respond(id, { action: 'decline', content: null, _meta: null })
    default:
      return srv.rpc.respondError(id, -32601, `GenieEngine does not handle ${method}`)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function waitForTurn(srv: CodexServer, turnId: string): Promise<CodexTurn> {
  const finished = finishedTurns.get(turnId)
  if (finished) {
    finishedTurns.delete(turnId)
    return Promise.resolve(finished)
  }
  // The process may already be gone (its exit settled the waiters it knew of).
  if (srv.proc.exitCode !== null || srv.proc.signalCode !== null) {
    return Promise.resolve({ id: turnId, status: 'failed', error: { message: 'The Codex assistant stopped unexpectedly.', codexErrorInfo: 'other' } })
  }
  return new Promise((resolve) => turnWaiters.set(turnId, { srv, resolve }))
}

/** Whether a thread/resume failure means the thread is gone for good (vs. a transient failure). */
function isThreadGone(err: unknown): boolean {
  return (
    err instanceof RpcError &&
    err.code === -32600 &&
    /no rollout found|invalid session id|not found/i.test(err.message)
  )
}

/**
 * Make the conversation's thread usable in this server process: a thread
 * restored from saved chat history (or started by an earlier process) must
 * be resumed first. Only a definitive "gone" answer drops it — forgetting the
 * thread on ANY failure silently forked the conversation into a fresh
 * context-less one whenever the resume merely flaked, which users
 * experienced as the assistant "losing its memory" after reopening a
 * project. Transient failures are retried, then surfaced as a send error.
 */
async function ensureThreadLoaded(srv: CodexServer): Promise<void> {
  for (let attempt = 0; threadId && !srv.loaded.has(threadId); attempt++) {
    try {
      await srv.rpc.request('thread/resume', { threadId, cwd: srv.projectPath, excludeTurns: true })
      srv.loaded.add(threadId)
    } catch (err) {
      if (isThreadGone(err)) {
        threadId = null
        return
      }
      if (attempt >= 2) {
        throw new Error(
          `Could not reopen the saved conversation (${err instanceof Error ? err.message : err}). Try again.`
        )
      }
      await sleep(300)
    }
  }
}

/**
 * Provider errors that mean the accumulated conversation no longer fits the
 * model's context window (observed: "Input length 202850 exceeds the maximum
 * allowed input length of 202720 tokens"; also the OpenAI/Anthropic
 * phrasings). Codex only classifies OpenAI's own error code as
 * contextWindowExceeded — third-party endpoints arrive as generic errors, so
 * the text is checked too. Once a thread hits this, every further turn in it
 * fails the same way — the way forward is a fresh thread seeded with a recap.
 */
const CONTEXT_OVERFLOW_RE =
  /context[_ -]?(length|window)|maximum (allowed )?(input|context|prompt)|input (length|is )?too long|prompt is too long|input length \d+ exceeds|too many (total )?(text bytes|input tokens)/i

/**
 * Provider/infra failures that tend to clear on their own: backend 5xx,
 * gateway trouble, capacity (observed from an OpenAI-compatible endpoint
 * mid-turn: "HTTP 500: Failed to find a worker for remote generation.").
 * Codex already retries each request several times; when it gives up anyway
 * the thread is still healthy — the agent loop just stopped — so the
 * recovery is to resume the SAME thread, never to roll over.
 */
const TRANSIENT_PROVIDER_RE =
  /HTTP (5\d\d|429)|internal server error|bad gateway|too many requests|overloaded|service unavailable|temporarily unavailable|failed to find a worker|kv cache|high demand/i

const TRANSIENT_ERROR_CODES = new Set([
  'internalServerError',
  'serverOverloaded',
  'rateLimitExceeded',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts'
])

/** Codex's error code for a turn, whichever shape it came in. */
function errorCode(turn: CodexTurn): string {
  const info = turn.error?.codexErrorInfo
  if (typeof info === 'string') return info
  return info && typeof info === 'object' ? (Object.keys(info)[0] ?? '') : ''
}

/** Backoff before each automatic resume of a transiently-failed turn. */
const TRANSIENT_RETRY_DELAYS_MS = [2000, 8000]

/**
 * What the model sees when its turn is resumed after a transient provider
 * error. A user-role message, like the recap: the renderer never displays
 * user-message echoes, so the user sees one seamless reply.
 */
const RESUME_NUDGE =
  '[Your previous response was cut off by a temporary provider error, not by the user. ' +
  'Continue exactly where you left off — do not restart the task or repeat work that already completed.]'

/**
 * A failed turn's error as the user should read it. Provider errors arrive
 * as raw JSON bodies; and once Codex's retries run out it replaces some
 * failures with canned text, so the proxy's record of what the provider (or
 * the network) actually said wins for those.
 */
function turnErrorText(turn: CodexTurn, startedAt: number): string {
  let text = turn.error?.message || 'The assistant stopped with an unknown error.'
  try {
    const inner = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message
    if (typeof inner === 'string' && inner) text = inner
  } catch {
    /* plain text already */
  }
  const upstream = lastUpstreamFailure(startedAt)
  if (upstream && TRANSIENT_ERROR_CODES.has(errorCode(turn))) text = upstream
  return text
}

/**
 * Text attachments ride inside the message: Codex turns carry text and
 * images only. Capped so one stray log file can't eat the context window.
 */
const MAX_INLINE_TEXT_CHARS = 60_000
const TEXT_ATTACHMENT_RE = /\.(txt|md|json|gd|tscn|cfg|csv|log)$/i

function decodeTextAttachment(attachment: ChatAttachment): string | null {
  const comma = attachment.dataUrl?.indexOf(',') ?? -1
  if (!attachment.dataUrl || comma === -1) return null
  if (!attachment.mime.startsWith('text/') && attachment.mime !== 'application/json' && !TEXT_ATTACHMENT_RE.test(attachment.name)) {
    return null
  }
  const text = Buffer.from(attachment.dataUrl.slice(comma + 1), 'base64').toString('utf8')
  return text.length > MAX_INLINE_TEXT_CHARS ? `${text.slice(0, MAX_INLINE_TEXT_CHARS)}\n[… truncated]` : text
}

/**
 * Apply an undo point made by /undo: drop the undone turns from the thread
 * for good before the conversation moves on (their files were already
 * restored when the user undid). Until now they stayed in the thread so
 * /redo could step forward again.
 */
async function applyPendingUndo(srv: CodexServer, projectPath: string, thread: string): Promise<void> {
  const state = await loadUndoState(projectPath, thread)
  if (!state.point) return
  await srv.rpc.request('thread/revert', { threadId: thread, beforeTurnId: state.point })
  // Turn ids are UUIDv7 (time-ordered), so the undone turns sort at or after the point.
  for (const id of Object.keys(state.before)) if (id >= state.point) delete state.before[id]
  state.point = null
  state.head = null
  await saveUndoState(projectPath, state)
}

/**
 * Start a turn and resolve once it completes. `snapshot` turns record the
 * project's files first, so /undo can restore them (not for resume nudges,
 * which continue the turn before them).
 */
async function runTurn(
  srv: CodexServer,
  projectPath: string,
  params: { threadId: string; input: unknown[]; model: ChatModelTier; clientUserMessageId?: string },
  snapshot: boolean
): Promise<CodexTurn> {
  // Stop pressed before the turn even started (e.g. while the server booted).
  if (cancelled) return { id: '', status: 'interrupted', error: null }
  const before = snapshot
    ? await captureSnapshot(projectPath).catch((err: unknown) => {
        // Best-effort: the turn still runs, it just can't restore files on undo.
        console.warn('[genieengine] project snapshot failed:', err)
        return null
      })
    : null
  const { turn } = await srv.rpc.request<{ turn: CodexTurn }>('turn/start', params)
  activeTurn = { threadId: params.threadId, turnId: turn.id }
  lastTurnId = turn.id
  if (before) {
    const state = await loadUndoState(projectPath, params.threadId)
    state.before[turn.id] = before
    await saveUndoState(projectPath, state).catch(() => {})
  }
  if (cancelled) interruptTurns(srv) // Stop pressed while the turn was starting
  return waitForTurn(srv, turn.id)
}

/**
 * Validates and kicks off a chat turn. Resolves as soon as the turn is
 * accepted; progress streams via chat:part events and completion (or
 * failure) arrives as a chat:done event when the turn completes.
 *
 * `tier` picks which chat model answers this message. It rides the turn as
 * the model, so switching tiers mid-conversation keeps the same thread — the
 * model changes, the history doesn't. `clientMessageId` is the renderer's id
 * for the user's message; Codex keeps it on the turn, which is how /undo
 * tells the renderer which message it took back.
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
  clientMessageId?: string,
  isRetry = false
): Promise<void> {
  if (!isRetry) {
    if (busy) throw new Error('A response is already in progress')
    // Claim the turn before the first await — two rapid sends could otherwise
    // both pass the guard above while the first was still starting its server.
    busy = true
    cancelled = false
  }

  let srv: CodexServer
  let thread: string
  let uploaded: SavedUpload[] = []
  let recap: string | null = null
  try {
    // The most common first-run failure — explain it before Codex turns it
    // into an opaque 401 several retries later.
    if (!(await resolveChatSlot(tier)).apiKey) {
      throw new Error(
        `The ${tier === 'large' ? 'Large' : 'Medium'} chat model isn't connected yet — its API key is missing.\n\n` +
          'Open the AI settings (gear icon) and add the API key for its endpoint, then try again.'
      )
    }
    srv = await ensureServer(projectPath)
    await ensureThreadLoaded(srv)
    if (!threadId) {
      // Starting a fresh thread while the project still has a saved
      // transcript (stale/lost thread, a chat from before Codex, or the
      // context-overflow rollover below): seed it with a recap of that
      // transcript. The chat window and the model must not diverge. After
      // /clear there is no saved transcript, so a cleared chat starts raw.
      recap = await loadTranscriptRecap(projectPath).catch(() => null)
      const { thread: started } = await srv.rpc.request<{ thread: { id: string } }>('thread/start', {
        cwd: projectPath
      })
      threadId = started.id
      srv.loaded.add(started.id)
    }
    thread = threadId
    await applyPendingUndo(srv, projectPath, thread)
    // Asset uploads (zips, folders, models…) are copied into the project's
    // .genieengine/attachments/ — the only place the sandboxed assistant can
    // reach them. Unlike the best-effort attachment saving below, a failure
    // here fails the whole send: the message must not describe files that
    // never arrived. The error text is user-readable (caps, unreadable
    // source). Copied after the thread checks so a failed resume can't
    // duplicate them.
    uploaded = await saveChatUploads(projectPath, attachments.filter((a) => a.path))
  } catch (err) {
    busy = false
    throw err
  }

  // Parts of finished turns are final — only the live turn needs delta state.
  partCache.clear()

  // The recap rides inside this message rather than as its own turn: a
  // separate priming turn would cost a full model round-trip. The renderer
  // shows its own copy of the user text, so the recap never appears in the UI.
  let text = recap ? `${recap}\n\n${message}` : message
  const inline = attachments.filter((a) => a.dataUrl)
  const images = inline.filter((a) => a.mime.startsWith('image/'))
  for (const doc of inline.filter((a) => !a.mime.startsWith('image/'))) {
    const content = decodeTextAttachment(doc)
    if (content !== null) text += `\n\n[Attached file: ${doc.name}]\n\`\`\`\n${content}\n\`\`\``
  }
  // Inline attachments are also saved under .genieengine/attachments/ with
  // their paths appended: a path is how the model gets back to a reference
  // image in later turns (view_image) and how the game-tester subagent —
  // which never sees this message — can compare a screenshot against it, and
  // the only way a PDF reaches the model at all. Best-effort — a failed save
  // just means the message goes out without the note.
  const saved = inline.length ? await saveChatAttachments(projectPath, inline).catch(() => [] as string[]) : []
  if (saved.length) {
    text +=
      `\n\n[The attached file${saved.length > 1 ? 's are' : ' is'} also saved at: ${saved.join(', ')} — ` +
      'open images there with view_image whenever you need another look, and give the path to the ' +
      'game-tester to compare against.]'
  }
  // Asset uploads reach the model as paths only (copied above) — a zip or a
  // 40 MB GLB inline would be useless to it. The note also spells out the
  // .genieengine/ catch: Godot ignores that directory, so assets must be
  // copied into the game tree to be usable.
  if (uploaded.length) {
    const list = uploaded.map((u) => (u.dir ? `${u.rel}/ (folder)` : u.rel)).join(', ')
    text +=
      `\n\n[The user uploaded asset file${uploaded.length > 1 ? 's' : ''} with this message, ` +
      `saved in the project at: ${list}. Explore what's inside — extract any .zip first ` +
      '(e.g. `unzip -o <file>.zip -d <folder>`). Everything under .genieengine/ is invisible ' +
      'to Godot, so copy the files the game needs into the proper assets/ sub-folders ' +
      'before wiring them into scenes.]'
  }
  const input: unknown[] = [
    ...images.map((a) => ({ type: 'image', url: a.dataUrl })),
    { type: 'text', text, text_elements: [] }
  ]

  const gen = generation
  const done = (payload: { ok: boolean; cancelled?: boolean; error?: string }): void => {
    if (gen === generation) sendToRenderer('chat:done', payload)
  }

  void (async () => {
    // Set when the turn died to context overflow and a rollover retry should
    // run: the retry happens in `finally` so this attempt's work is fully
    // settled first, and `busy` stays claimed across the handoff so the
    // renderer experiences one seamless turn.
    let retryInFreshThread = false
    const startedAt = Date.now()
    try {
      let turn = await runTurn(srv, projectPath, { threadId: thread, input, model: tier, clientUserMessageId: clientMessageId }, true)
      // A transient backend failure kills the agent loop mid-turn, but
      // everything up to it — applied edits, tool results — is safely in the
      // thread. Resume the same thread with a nudge rather than surfacing the
      // error: re-sending the user message would duplicate it, and a fresh
      // thread would orphan the completed work. Bounded, so a provider that
      // is genuinely down still surfaces its error.
      for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
        const detail = turn.status === 'failed' ? turnErrorText(turn, startedAt) : null
        const transient = detail !== null && (TRANSIENT_ERROR_CODES.has(errorCode(turn)) || TRANSIENT_PROVIDER_RE.test(detail))
        if (!transient || cancelled) break
        console.warn(`[genieengine] transient provider error, resuming turn (attempt ${attempt + 1}):`, detail)
        await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt])
        if (cancelled) break
        turn = await runTurn(
          srv,
          projectPath,
          { threadId: thread, input: [{ type: 'text', text: RESUME_NUDGE, text_elements: [] }], model: tier },
          false
        )
      }
      const detail = turn.status === 'failed' ? turnErrorText(turn, startedAt) : null
      const overflow = detail !== null && (errorCode(turn) === 'contextWindowExceeded' || CONTEXT_OVERFLOW_RE.test(detail))
      // The conversation no longer fits the model's context window; nothing
      // sent into this thread can ever succeed again. Roll over: the next
      // thread starts fresh and loadTranscriptRecap carries the visible
      // conversation into it. Without this, users were stuck resending into
      // a permanently failing conversation until they gave up.
      if (overflow) {
        threadId = null
        if (!isRetry && !cancelled) {
          retryInFreshThread = true
          return
        }
      }
      if (cancelled || turn.status === 'interrupted') {
        done({ ok: false, cancelled: true })
      } else if (detail !== null) {
        done({
          ok: false,
          error: overflow
            ? `This message is too large for the model's context window even in a fresh conversation — ` +
              `try a shorter message or smaller attachments. (${detail})`
            : detail
        })
      } else {
        done({ ok: true })
      }
    } catch (err) {
      done({ ok: false, cancelled, error: cancelled ? undefined : err instanceof Error ? err.message : String(err) })
    } finally {
      if (gen === generation) {
        activeTurn = null
        if (retryInFreshThread) {
          void sendChatMessage(message, projectPath, attachments, tier, clientMessageId, true).catch((err) => {
            // The retry failed before its own turn could report — close out the
            // renderer's pending turn here or the chat would spin forever.
            done({ ok: false, error: err instanceof Error ? err.message : String(err) })
            busy = false
          })
        } else {
          busy = false
        }
      }
    }
  })()
}

/** Interrupt the running turn and any subagent turns working for it. */
function interruptTurns(srv: CodexServer): void {
  const targets = [...(activeTurn ? [[activeTurn.threadId, activeTurn.turnId]] : []), ...childTurns.entries()]
  for (const [thread, turnId] of targets) {
    void srv.rpc.request('turn/interrupt', { threadId: thread, turnId }).catch(() => {})
  }
}

export function cancelChat(): void {
  if (!busy) return
  cancelled = true
  if (server) interruptTurns(server)
}

/*
 * /undo and /redo. Reverting to a user turn hides that turn and everything
 * after it from the model AND restores the project files to the snapshot
 * taken before the turn ran; redo steps forward again, and redo past the
 * newest undone turn restores the state from before the first undo. The
 * undo point is persisted (snapshots.ts), so it survives app restarts — but
 * sending a new message makes it permanent (the undone turns are dropped
 * from the thread then), which is why redo availability is additionally
 * tracked renderer-side.
 */

/**
 * The thread's real user turns, oldest first, with the renderer's id for
 * each one's message. Turns without a client id are the synthetic resume
 * nudges (RESUME_NUDGE): they belong to the user turn before them, so a
 * revert must never target one — it would restore half a turn.
 */
async function listUserTurns(srv: CodexServer, thread: string): Promise<{ id: string; clientId: string }[]> {
  const turns: { id: string; clientId: string }[] = []
  let cursor: string | null = null
  do {
    const page: { data?: CodexTurn[]; nextCursor?: string | null } = await srv.rpc.request('thread/turns/list', {
      threadId: thread,
      cursor,
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'summary'
    })
    for (const turn of page.data ?? []) {
      const user = (turn.items ?? []).find((item) => item.type === 'userMessage')
      if (typeof user?.clientId === 'string' && user.clientId) turns.push({ id: turn.id, clientId: user.clientId })
    }
    cursor = page.nextCursor ?? null
  } while (cursor)
  return turns
}

/**
 * The thread undo/redo operate on, or null when there is no conversation (no
 * thread yet, or the saved one is gone). Never starts a thread — unlike a
 * send, an undo must not open a fresh conversation.
 */
async function activeThread(projectPath: string): Promise<{ srv: CodexServer; thread: string } | null> {
  if (!threadId) return null
  const srv = await ensureServer(projectPath)
  await ensureThreadLoaded(srv)
  return threadId ? { srv, thread: threadId } : null
}

/** Wait for an aborted turn to settle (release `busy`) before reverting under it. */
async function waitForIdle(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (busy && Date.now() < deadline) await sleep(100)
  return !busy
}

/**
 * /undo: rewind to just before the most recent user turn (or one turn
 * further back on repeat), restoring the files that turn touched. Returns the
 * renderer's id of the undone message so the renderer can drop that turn
 * from its transcript and put the text back in the composer.
 */
export async function undoChat(projectPath: string): Promise<{ revertedTo: string }> {
  // Undoing a turn that is still streaming stops it first, then reverts once
  // it has settled.
  if (busy) {
    cancelChat()
    if (!(await waitForIdle(8000))) {
      throw new Error('Could not stop the current response — press Stop, then try again.')
    }
  }
  const active = await activeThread(projectPath)
  if (!active) throw new Error('Nothing to undo.')
  const { srv, thread } = active
  busy = true // hold the turn so a racing send can't interleave with the revert
  try {
    const state = await loadUndoState(projectPath, thread)
    const turns = await listUserTurns(srv, thread)
    const pointIndex = turns.findIndex((t) => t.id === state.point)
    const target = turns[(pointIndex === -1 ? turns.length : pointIndex) - 1]
    if (!target) throw new Error('Nothing to undo.')
    if (pointIndex === -1) {
      // First step back: remember the current files for a full redo.
      state.head = await captureSnapshot(projectPath).catch(() => null)
    }
    const tree = state.before[target.id]
    if (tree) await restoreSnapshot(projectPath, tree)
    state.point = target.id
    await saveUndoState(projectPath, state)
    return { revertedTo: target.clientId }
  } finally {
    busy = false
  }
}

/**
 * /redo: step the undo point forward one user turn, or fully restore the
 * conversation and files once the newest undone turn is reached.
 */
export async function redoChat(projectPath: string): Promise<void> {
  if (busy) throw new Error('A response is already in progress')
  const active = await activeThread(projectPath)
  if (!active) throw new Error('Nothing to redo.')
  const { srv, thread } = active
  busy = true
  try {
    const state = await loadUndoState(projectPath, thread)
    if (!state.point) throw new Error('Nothing to redo.')
    const turns = await listUserTurns(srv, thread)
    const index = turns.findIndex((t) => t.id === state.point)
    const next = index === -1 ? undefined : turns[index + 1]
    if (next) {
      const tree = state.before[next.id]
      if (tree) await restoreSnapshot(projectPath, tree)
      state.point = next.id
    } else {
      if (state.head) await restoreSnapshot(projectPath, state.head)
      state.point = null
      state.head = null
    }
    await saveUndoState(projectPath, state)
  } finally {
    busy = false
  }
}

/** Deliver the user's answers for a pending question (unblocks the turn). */
export async function answerQuestion(requestID: string, answers: string[][]): Promise<void> {
  const pending = pendingQuestions.get(requestID)
  if (!pending) throw new Error('That question is no longer waiting for an answer.')
  pendingQuestions.delete(requestID)
  pending.srv.rpc.respond(pending.rpcId, {
    answers: Object.fromEntries(pending.questionIds.map((id, i) => [id, { answers: answers[i] ?? [] }]))
  })
}

/** Dismiss a pending question — the assistant gets no answers and carries on. */
export async function rejectQuestion(requestID: string): Promise<void> {
  const pending = pendingQuestions.get(requestID)
  if (!pending) return
  pendingQuestions.delete(requestID)
  pending.srv.rpc.respond(pending.rpcId, { answers: {} })
}

/**
 * The question the conversation is blocked on, if any. Lets a freshly
 * (re)loaded window re-show the question card instead of leaving the turn
 * stuck on a prompt that's no longer on screen.
 */
export async function pendingQuestion(): Promise<ChatQuestionRequest | null> {
  return pendingQuestions.values().next().value?.request ?? null
}

/** Start a fresh conversation in the same project (keeps the server warm). */
export function newChatSession(): void {
  cancelChat()
  threadId = null
  // The old conversation's subagents must not report into the cleared chat.
  childThreads.clear()
  childParts.clear()
  childTurns.clear()
}

/**
 * Continue a thread saved in the project's chat history (called when a
 * project with a restored transcript is opened). Resumed lazily on the next
 * send — see ensureThreadLoaded. A null id is ignored rather than applied: it
 * means the chat file is missing or unreadable, and wiping a live thread over
 * that (e.g. on a window reload whose loadState found nothing) would silently
 * fork the conversation. Real resets go through newChatSession (/clear) or
 * shutdownChat (project switch).
 */
export function resumeSession(id: string | null): void {
  if (busy || !id) return
  threadId = id
}

/** The conversation's thread id, saved with the transcript for later resume. */
export function getSessionID(): string | null {
  return threadId
}

/** Tear down the chat server — project switch or app quit. */
export function shutdownChat(): void {
  generation++
  threadId = null
  busy = false
  cancelled = false
  activeTurn = null
  childThreads.clear()
  childParts.clear()
  childTurns.clear()
  partCache.clear()
  killServer()
}
