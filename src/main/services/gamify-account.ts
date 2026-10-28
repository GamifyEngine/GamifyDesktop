import { app, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { GamifyAccountStatus, GamifyUser } from '../../shared/types'
import { getMainWindow } from '../window'
import { credentialsStore } from './asset-store'

/**
 * The user's Gamify account — the alternative to bringing their own model
 * endpoints. Signed in, the assistant's model requests (model-proxy.ts) and
 * its 2D art (gptimage.ts) go to the Gamify backend at trygamify.io with the
 * account's session token, and are paid for with the account's credits.
 *
 * Signing in follows the native-app OAuth pattern (RFC 8252, with PKCE from
 * RFC 7636): the app listens on a one-off loopback port and opens the site's
 * authorize page in the browser; the user signs in there (Sign in with
 * Apple) and the site sends the browser back to the loopback port with a
 * one-time code that only this app can redeem — it alone knows the PKCE
 * verifier. Works the same on every platform, packaged or not, with nothing
 * to register with the OS. The session token is stored like the API keys:
 * an owner-only credentials file the agent's sandbox can't read, attached to
 * requests by the app itself and never handed to Codex.
 */

/** The Gamify site; GAMIFY_API_BASE points a development build at a local backend (http://localhost:8000). */
export const GAMIFY_SITE = (process.env.GAMIFY_API_BASE || 'https://trygamify.io').replace(/\/+$/, '')

/** The model name sent to the Gamify backend, which swaps in the model its manager configured. */
export const GAMIFY_CHAT_MODEL = 'gamify-model'
export const GAMIFY_IMAGE_MODEL = 'gamify-image'

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000
/** How long the loaded account (name, credits) is shown before it is fetched again. */
const REFRESH_AFTER_MS = 60 * 1000

const store = credentialsStore<{ token: string }>('gamify-account.json')

/** The parts of the backend's user and config payloads the app reads (api/common.py there). */
interface BackendUser {
  username?: string | null
  name?: string | null
  email?: string | null
  credits?: number
  unlimited_credits?: boolean
}
interface BackendPayload {
  token?: string
  user?: BackendUser
  config?: { image_generation_enabled?: boolean }
}

let account: { user: GamifyUser; imageGeneration: boolean } | null = null
let lastRefresh = 0
let pendingSignIn: { cancel: (err: Error) => void } | null = null

function remember(payload: BackendPayload): void {
  if (!payload.user) return
  const user = payload.user
  account = {
    user: {
      displayName: user.username ? `@${user.username}` : user.name || user.email || 'Gamify account',
      email: user.email ?? null,
      credits: Number(user.credits ?? 0),
      unlimitedCredits: Boolean(user.unlimited_credits)
    },
    imageGeneration: payload.config?.image_generation_enabled !== false
  }
  lastRefresh = Date.now()
}

/** The account's session token, or null while signed out. */
export async function gamifyToken(): Promise<string | null> {
  return (await store.load())?.token ?? null
}

/** Whether the account includes 2D art generation, as last loaded (on until known otherwise). */
export function gamifyIncludesImages(): boolean {
  return account?.imageGeneration ?? true
}

/** A call to the backend's JSON API (not streaming — model requests go through model-proxy.ts). */
function api(path: string, init: { method?: 'GET' | 'POST'; token?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
  return fetch(`${GAMIFY_SITE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': `GamifyDesktop/${app.getVersion()} (${process.platform})`,
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 15000)
  })
}

/** The backend's error text (`{"error": {"message": …}}`), or the status. */
async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
  return body?.error?.message || `HTTP ${res.status}`
}

/**
 * Forgets the stored session — on sign-out, or when the backend rejected
 * `rejected` (signed out elsewhere, the session revoked, the account
 * deleted) so the setup panel asks to sign in again; the model proxy and
 * image generation report their 401s here too. A rejection of a token that
 * has since been replaced by a new sign-in is ignored.
 */
export async function forgetGamifySession(rejected?: string): Promise<void> {
  if (rejected !== undefined && (await gamifyToken()) !== rejected) return
  account = null
  await store.clear()
}

/** Reloads the account behind `token`. Offline, the last known account stays. */
async function refresh(token: string): Promise<void> {
  lastRefresh = Date.now()
  try {
    const res = await api('/api/v1/me', { token, timeoutMs: 5000 })
    if (res.status === 401) {
      await forgetGamifySession(token)
    } else if (res.ok) {
      remember((await res.json()) as BackendPayload)
    }
  } catch {
    // Offline or the site is down.
  }
}

export async function getGamifyStatus(): Promise<GamifyAccountStatus> {
  let token = await gamifyToken()
  if (token && Date.now() - lastRefresh > REFRESH_AFTER_MS) {
    await refresh(token)
    token = await gamifyToken()
  }
  return {
    site: GAMIFY_SITE,
    signedIn: token !== null,
    signingIn: pendingSignIn !== null,
    user: token ? (account?.user ?? null) : null,
    // Unknown until the account loads: assume on — the backend says so if not.
    imageGeneration: token !== null && gamifyIncludesImages()
  }
}

/** A small page for the browser tab the sign-in comes back to. */
function sendPage(res: ServerResponse, status: number, title: string, text: string): void {
  const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' })
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · GamifyDesktop</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0e0e13; color: #e9e9f1; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0; color: #9b9bb0; font-size: 15px; }
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(text)}</p></main></body></html>`)
}

function bringAppToFront(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  // macOS only raises the window of an app that isn't active when asked to.
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.focus()
}

/** Exchanges the one-time code the browser brought back for a session and stores it. */
async function redeem(code: string, verifier: string, redirectUri: string): Promise<void> {
  const res = await api('/api/v1/auth/desktop/token', {
    method: 'POST',
    body: { code, code_verifier: verifier, redirect_uri: redirectUri, app_version: app.getVersion() }
  })
  if (!res.ok) throw new Error(`${new URL(GAMIFY_SITE).host} refused the sign-in: ${await errorText(res)}`)
  const payload = (await res.json()) as BackendPayload
  if (!payload.token) throw new Error(`${new URL(GAMIFY_SITE).host} sent no session.`)
  await store.save({ token: payload.token })
  remember(payload)
}

/**
 * Signs in through the browser. Resolves once the account is stored; rejects
 * when the user cancels (here or in the browser), it times out, or the site
 * refuses the code. Starting again abandons a sign-in still waiting.
 */
export function signInToGamify(): Promise<void> {
  pendingSignIn?.cancel(new Error('Sign-in restarted.'))
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')

  return new Promise<void>((resolve, reject) => {
    let redirectUri = ''
    let settled = false
    const server = createServer((req, res) => void onCallback(req, res))
    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pendingSignIn = null
      // Stops listening; the page already sent still reaches the browser.
      server.close()
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('Signing in took too long — try again.')), SIGN_IN_TIMEOUT_MS)
    pendingSignIn = { cancel: finish }

    async function onCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404, { connection: 'close' }).end()
        return
      }
      if (settled || url.searchParams.get('state') !== state) {
        sendPage(res, 400, 'This sign-in has expired', 'Start signing in again from GamifyDesktop.')
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        sendPage(res, 200, 'Sign-in cancelled', 'You can close this tab.')
        finish(new Error('Sign-in was cancelled.'))
        return
      }
      try {
        await redeem(code, verifier, redirectUri)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendPage(res, 502, 'Sign-in failed', message)
        finish(new Error(message))
        return
      }
      sendPage(res, 200, 'You’re signed in', 'You can close this tab and go back to GamifyDesktop.')
      finish(null)
      bringAppToFront()
    }

    server.once('error', (err) => finish(err))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      redirectUri = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/callback`
      const query = new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
      shell.openExternal(`${GAMIFY_SITE}/desktop/authorize?${query}`).catch((err: Error) => finish(err))
    })
  })
}

export function cancelGamifySignIn(): void {
  pendingSignIn?.cancel(new Error('Sign-in was cancelled.'))
}

export async function signOutOfGamify(): Promise<void> {
  const token = await gamifyToken()
  await forgetGamifySession()
  // Ends the session on the server too; offline, it simply expires there.
  if (token) await api('/api/v1/auth/logout', { method: 'POST', token, timeoutMs: 5000 }).catch(() => {})
}

export function openGamifyAccountPage(): Promise<void> {
  return shell.openExternal(`${GAMIFY_SITE}/account`)
}
