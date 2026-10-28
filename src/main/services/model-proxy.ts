import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ChatModelTier } from '../../shared/types'
import { isOpenRouterEndpoint, resolveChatRoute, type ChatRoute } from './chat-setup'
import { forgetGamifySession, GAMIFY_CHAT_MODEL } from './gamify-account'

/**
 * Local proxy between Codex and the user's model endpoints. Codex is pointed
 * at it as its only model provider (see codex-config.ts) and names the chat
 * slot — 'medium' or 'large' — as the model; the proxy looks the slot up and
 * forwards the Responses API request to the slot's real endpoint. Why not
 * point Codex at the endpoints directly:
 *
 *  - Namespaced tools. Codex 0.164 groups MCP tools (the gamifydesktop game
 *    tools) and its subagent tools into Responses `namespace` tools, an
 *    OpenAI-specific shape. Third-party Responses implementations — OpenRouter
 *    included — document plain `function` tools only, so the game tools would
 *    be rejected or silently dropped. The proxy flattens every namespace into
 *    plain functions named `<namespace>__<tool>` on the way out and restores
 *    `namespace` + `name` on the function calls streaming back, so Codex
 *    routes them as if the provider understood namespaces natively.
 *  - Keys stay out of the agent's reach. Codex only ever holds a per-launch
 *    proxy token; the real API key is attached here, in the app process.
 *  - Per-turn slot switching. A Codex thread is bound to one model provider,
 *    but the Medium and Large slots may live on different endpoints with
 *    different keys. Routing on the model name lets one conversation move
 *    between them freely.
 *  - Thinking / reasoning effort, mapped onto each provider's wire spelling.
 *  - The Gamify account. When the assistant runs on it, both slots go to the
 *    Gamify backend with the account's session token instead (the backend
 *    picks the model and charges the account's credits) — switching between
 *    it and the user's own models is again just a different route per
 *    request.
 *
 * Bound to 127.0.0.1 and guarded by the token, so other local processes
 * can't spend the user's credits through it.
 */

interface ProxyEndpoint {
  /** Base URL Codex's provider entry points at (Codex appends /responses). */
  baseUrl: string
  /** Bearer token Codex must present (handed to it via an env var). */
  token: string
}

let server: Server | null = null
let starting: Promise<ProxyEndpoint> | null = null

/**
 * The most recent upstream failure: Codex replaces some provider errors with
 * canned text once its retries run out ("We're currently experiencing high
 * demand…" for any 5xx), which would hide e.g. a DNS failure from the chat's
 * "Disconnected" detection. codex.ts uses this to report what really happened.
 */
let lastFailure: { at: number; message: string } | null = null

export function lastUpstreamFailure(since: number): string | null {
  return lastFailure && lastFailure.at >= since ? lastFailure.message : null
}

export function ensureModelProxy(): Promise<ProxyEndpoint> {
  if (!starting) {
    starting = new Promise<ProxyEndpoint>((resolve, reject) => {
      const token = randomBytes(24).toString('hex')
      const srv = createServer((req, res) => void handle(req, res, token))
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        server = srv
        const address = srv.address()
        const port = typeof address === 'object' && address ? address.port : 0
        resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, token })
      })
    })
    starting.catch(() => (starting = null))
  }
  return starting
}

export function stopModelProxy(): void {
  server?.close()
  server = null
  starting = null
}

/** An error in the OpenAI format, which Codex knows how to surface. */
function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message, type: status === 401 ? 'authentication_error' : 'proxy_error' } }))
}

/** Constant-time token check — `!==` would leak prefix-match timing to other local users. */
function authorized(req: IncomingMessage, token: string): boolean {
  const a = Buffer.from(String(req.headers.authorization ?? ''))
  const b = Buffer.from(`Bearer ${token}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Requests carry the whole conversation (screenshots and attachments included). */
const MAX_BODY_BYTES = 100 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('request too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  if (!authorized(req, token)) return sendError(res, 401, 'invalid proxy token')
  if (req.method !== 'POST' || !req.url?.split('?')[0].endsWith('/responses')) {
    return sendError(res, 404, `not found: ${req.method} ${req.url}`)
  }
  let body: Json
  try {
    body = JSON.parse(await readBody(req)) as Json
  } catch (err) {
    return sendError(res, 400, `unreadable request: ${err instanceof Error ? err.message : err}`)
  }
  // Anything but 'large' — including a model a subagent was spawned with
  // explicitly — runs on the Medium slot.
  const tier: ChatModelTier = body.model === 'large' ? 'large' : 'medium'
  const route = await resolveChatRoute(tier)
  let upstream: Upstream
  if (route.kind === 'gamify') {
    if (!route.token) {
      return sendError(
        res,
        401,
        'You are signed out of your Gamify account. Sign in again in the AI settings (gear icon), then try again.'
      )
    }
    // Codex's per-conversation request id: the backend files the usage under it.
    const requestId = req.headers['x-client-request-id']
    upstream = {
      endpoint: route.endpoint,
      bearer: route.token,
      gamify: true,
      headers: typeof requestId === 'string' ? { 'x-client-request-id': requestId } : {}
    }
  } else {
    if (!route.apiKey) {
      return sendError(
        res,
        401,
        `No API key is configured for the ${tier === 'large' ? 'Large' : 'Medium'} model. ` +
          'Add one in the AI settings (gear icon), then try again.'
      )
    }
    upstream = { endpoint: route.endpoint, bearer: route.apiKey, gamify: false, headers: {} }
  }
  const restore = rewriteRequest(body, route)
  forward(res, upstream, JSON.stringify(body), restore)
}

/** Where a request goes and what it authenticates with. */
interface Upstream {
  /** Base URL of the Responses API; /responses is appended. */
  endpoint: string
  bearer: string
  /** The Gamify backend, where a 401 means the account's session has ended. */
  gamify: boolean
  /** Extra request headers passed on. */
  headers: Record<string, string>
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Responses API payloads are open-ended JSON */
type Json = Record<string, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A flattened tool name → the namespaced tool it stands for. */
type RestoreMap = Map<string, { namespace: string; name: string }>

/** OpenAI's (and most providers') function-name rule. */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Deterministic, so the same tool flattens to the same name in every request
 * — history replays earlier calls by name. Names that would break the
 * provider's rule (too long, odd characters) fall back to a hashed form.
 */
function flatToolName(namespace: string, name: string): string {
  const joined = `${namespace}__${name}`
  if (TOOL_NAME_RE.test(joined)) return joined
  const hash = createHash('sha256').update(joined).digest('hex').slice(0, 8)
  return `${joined.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 55)}_${hash}`
}

const isToolCall = (item: Json | undefined): boolean =>
  item?.type === 'function_call' || item?.type === 'custom_tool_call'

/**
 * Turns Codex's request into one any Responses endpoint accepts, in place.
 * Returns what's needed to map the response's tool calls back.
 */
function rewriteRequest(body: Json, route: ChatRoute): RestoreMap {
  const restore: RestoreMap = new Map()
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.flatMap((tool: Json) => {
      if (tool?.type !== 'namespace' || !Array.isArray(tool.tools)) return [tool]
      return tool.tools.map((inner: Json) => {
        const flat = flatToolName(tool.name, inner.name)
        restore.set(flat, { namespace: tool.name, name: inner.name })
        return { ...inner, name: flat }
      })
    })
  }
  // Earlier calls in the history carry their namespace too.
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (isToolCall(item) && typeof item.namespace === 'string') {
      item.name = flatToolName(item.namespace, item.name)
      delete item.namespace
    }
  }
  if (typeof body.tool_choice?.namespace === 'string') {
    body.tool_choice = { ...body.tool_choice, name: flatToolName(body.tool_choice.namespace, body.tool_choice.name) }
    delete body.tool_choice.namespace
  }

  // Codex-internal request metadata (installation/session ids) — OpenAI-only,
  // and nothing a third-party provider needs to see.
  delete body.client_metadata
  if (route.kind === 'gamify') {
    // The backend swaps in the model its manager configured, with its own settings.
    body.model = GAMIFY_CHAT_MODEL
    return restore
  }
  body.model = route.model
  // Effort uses the Responses API's own field. Thinking has no standard
  // Responses field: OpenRouter's unified spelling is `reasoning.enabled`;
  // elsewhere the slot keeps sending the top-level `thinking` field these
  // settings have always sent (DeepSeek-style, honored by the servers that
  // implement hybrid thinking).
  if (route.effort !== 'default') body.reasoning = { ...body.reasoning, effort: route.effort }
  if (route.thinking !== 'default') {
    if (isOpenRouterEndpoint(route.endpoint)) body.reasoning = { ...body.reasoning, enabled: route.thinking === 'enabled' }
    else body.thinking = { type: route.thinking }
  }
  return restore
}

/** Puts a flattened tool call back in the namespaced form Codex dispatches on. */
function restoreToolCall(item: Json | undefined, restore: RestoreMap): void {
  if (!isToolCall(item) || !item) return
  const original = restore.get(item.name)
  if (!original) return
  item.name = original.name
  item.namespace = original.namespace
}

/**
 * Rewrites a server-sent-event stream as it passes through. Events are
 * separated by a blank line; only `data:` JSON payloads that carry tool calls
 * change — keep-alive comments (OpenRouter sends ": OPENROUTER PROCESSING")
 * and everything else pass through untouched.
 */
function sseRewriter(restore: RestoreMap): { push: (chunk: string) => string; flush: () => string } {
  let buffer = ''
  const rewrite = (block: string): string => {
    const lines = block.split(/\r?\n/)
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''))
    if (data.length === 0) return block
    let event: Json
    try {
      event = JSON.parse(data.join('\n')) as Json
    } catch {
      return block // e.g. a `[DONE]` sentinel
    }
    restoreToolCall(event.item, restore)
    for (const item of Array.isArray(event.response?.output) ? event.response.output : []) restoreToolCall(item, restore)
    return [...lines.filter((l) => !l.startsWith('data:')), `data: ${JSON.stringify(event)}`].join('\n')
  }
  return {
    push(chunk) {
      buffer += chunk
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      return blocks.map((b) => `${rewrite(b)}\n\n`).join('')
    },
    flush() {
      const rest = buffer
      buffer = ''
      return rest ? `${rewrite(rest)}\n\n` : ''
    }
  }
}

/** Short human-readable reason out of a provider's error body. */
function errorMessageOf(status: number, raw: string): string {
  try {
    const message = (JSON.parse(raw) as Json)?.error?.message
    if (typeof message === 'string' && message) return `HTTP ${status}: ${message}`
  } catch {
    /* not JSON */
  }
  return `HTTP ${status}: ${raw.slice(0, 300) || 'no details'}`
}

/**
 * node:http(s), not fetch: undici aborts bodies idle for 5 minutes, and a
 * reasoning model can legitimately go quiet that long mid-stream.
 */
function forward(res: ServerResponse, target: Upstream, payload: string, restore: RestoreMap): void {
  let url: URL
  try {
    url = new URL(`${target.endpoint.replace(/\/+$/, '')}/responses`)
  } catch {
    return sendError(res, 400, `"${target.endpoint}" is not a valid API endpoint URL — fix it in the AI settings.`)
  }
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = send(
    url,
    {
      method: 'POST',
      timeout: 0,
      headers: {
        ...target.headers,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${target.bearer}`,
        'content-length': Buffer.byteLength(payload)
      }
    },
    (up) => {
      const status = up.statusCode ?? 502
      const type = String(up.headers['content-type'] ?? '')
      // The account's session is gone (signed out elsewhere, revoked): the
      // setup panel asks to sign in again.
      if (target.gamify && status === 401) void forgetGamifySession(target.bearer)
      res.writeHead(status, { 'content-type': type || 'application/json' })
      if (status >= 300) {
        // Pass the provider's error through for Codex, remembering it too.
        let raw = ''
        up.setEncoding('utf8')
        up.on('data', (chunk: string) => {
          raw += chunk
          res.write(chunk)
        })
        up.on('end', () => {
          lastFailure = { at: Date.now(), message: errorMessageOf(status, raw) }
          res.end()
        })
      } else if (type.includes('text/event-stream')) {
        const rewriter = sseRewriter(restore)
        up.setEncoding('utf8')
        up.on('data', (chunk: string) => res.write(rewriter.push(chunk)))
        up.on('end', () => res.end(rewriter.flush()))
      } else {
        up.pipe(res)
      }
      up.on('error', () => res.destroy())
    }
  )
  upstream.on('error', (err) => {
    lastFailure = { at: Date.now(), message: `Could not reach ${target.endpoint} (${err.message})` }
    if (res.headersSent) res.destroy()
    else sendError(res, 502, lastFailure.message)
  })
  // Codex hung up (turn interrupted): stop the upstream generation too, so an
  // abandoned response doesn't keep billing.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy()
  })
  upstream.end(payload)
}
