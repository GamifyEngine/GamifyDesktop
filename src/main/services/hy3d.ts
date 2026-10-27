import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { assetDir, credentialsStore, IMAGE_MIME, slug } from './asset-store'
import { extractZip } from './export'

/**
 * Tencent HY 3D ("Hunyuan To 3D Pro") client: generates 3D assets from a text
 * prompt or reference image. Used by the AI through the MCP harness tool
 * `generate_3d_asset` (test-harness.ts), gated on the user having saved
 * Tencent credentials in the setup panel — without them the tool is never
 * offered to the agent (see mcp-bridge.mjs).
 *
 * API: https://www.tencentcloud.com/document/product/1284/75287
 * Flow: SubmitHunyuanTo3DProJob → poll QueryHunyuanTo3DProJob until DONE/FAIL
 * → download ResultFile3Ds (model archive + preview) into the project's
 * assets/ tree. Requests are signed with TC3-HMAC-SHA256.
 */

const HOST = 'hunyuan.intl.tencentcloudapi.com'
const SERVICE = 'hunyuan'
const VERSION = '2023-09-01'
// The only region the HY 3D Global (intl) service is served from today.
const REGION = 'ap-singapore'

const POLL_INTERVAL_MS = 5000
const POLL_BUDGET_MS = 12 * 60 * 1000
// The API allows 3 concurrent jobs per account; leave one for other clients.
const MAX_CONCURRENT_JOBS = 2
// Tencent's default (500k faces) is far too heavy for game assets.
const DEFAULT_FACE_COUNT = 60000

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface Hy3dCredentials extends Record<string, string> {
  secretId: string
  secretKey: string
}

const store = credentialsStore<Hy3dCredentials>('hy3d-credentials.json')

export async function isHy3dConfigured(): Promise<boolean> {
  return store.isConfigured()
}

/** Save (both fields non-empty) or clear (both empty) the Tencent credentials. */
export async function saveHy3dCredentials(secretId: string, secretKey: string): Promise<void> {
  const id = secretId.trim()
  const key = secretKey.trim()
  if (!id && !key) return store.clear()
  if (!id || !key) throw new Error('Both the Tencent SecretId and SecretKey are required.')
  return store.save({ secretId: id, secretKey: key })
}

// ---------------------------------------------------------------------------
// TC3-HMAC-SHA256 request signing
// (https://www.tencentcloud.com/document/product/213/33224 — implementation
// verified against the worked example in that document.)
// ---------------------------------------------------------------------------

const sha256hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex')
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest()

export function tc3Sign(
  creds: Hy3dCredentials,
  host: string,
  service: string,
  payload: string,
  timestamp: number
): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json; charset=utf-8\nhost:${host}\n`,
    'content-type;host',
    sha256hex(payload)
  ].join('\n')
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), `${date}/${service}/tc3_request`, sha256hex(canonicalRequest)].join('\n')
  const secretDate = hmac(`TC3${creds.secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = hmac(secretSigning, stringToSign).toString('hex')
  return `TC3-HMAC-SHA256 Credential=${creds.secretId}/${date}/${service}/tc3_request, SignedHeaders=content-type;host, Signature=${signature}`
}

async function apiCall<T>(creds: Hy3dCredentials, action: string, params: Record<string, unknown>): Promise<T> {
  const payload = JSON.stringify(params)
  const timestamp = Math.floor(Date.now() / 1000)
  const res = await fetch(`https://${HOST}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      host: HOST,
      authorization: tc3Sign(creds, HOST, SERVICE, payload, timestamp),
      'x-tc-action': action,
      'x-tc-version': VERSION,
      'x-tc-timestamp': String(timestamp),
      'x-tc-region': REGION
    },
    body: payload
  })
  const body = (await res.json()) as { Response?: T & { Error?: { Code: string; Message: string } } }
  const response = body.Response
  if (!response) throw new Error(`Tencent API returned an unexpected payload (HTTP ${res.status})`)
  if (response.Error) throw new Error(`Tencent HY3D ${action} failed: ${response.Error.Code} — ${response.Error.Message}`)
  return response
}

// ---------------------------------------------------------------------------
// Asset generation
// ---------------------------------------------------------------------------

export interface GenerateAssetRequest {
  /** Text description of the asset (Text-To-3D). */
  prompt?: string
  /** Project-relative path to a reference image (Image-To-3D). */
  imagePath?: string
  /** Destination under assets/, e.g. "entities/e_player" — mirrors the ECS layout. */
  folder: string
  /** Asset name; becomes the containing folder and file base name. */
  name: string
  faceCount?: number
  generateType?: 'Normal' | 'LowPoly' | 'Geometry' | 'Sketch'
  enablePBR?: boolean
}

export interface GeneratedAsset {
  /** Project-relative paths of every file written. */
  files: string[]
  /** Base64 of a static preview image, when the API returned one. */
  previewBase64?: string
  previewMime?: string
  /** Turntable animation (GIF) — nicer than a still for the chat preview. */
  turntableBase64?: string
  turntableMime?: string
}

interface File3D {
  Type?: string
  Url?: string
  PreviewImageUrl?: string
}

let activeJobs = 0

function extensionFromUrl(url: string, fallback: string): string {
  const match = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(new URL(url).pathname)
  return match ? match[1].toLowerCase() : fallback
}

export async function generateAsset(projectPath: string, request: GenerateAssetRequest): Promise<GeneratedAsset> {
  const creds = await store.load()
  if (!creds) throw new Error('Tencent HY 3D is not configured. The user can add credentials in the AI setup panel.')
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    throw new Error(`Too many 3D generations in flight (max ${MAX_CONCURRENT_JOBS}) — wait for one to finish.`)
  }
  if (!request.prompt?.trim() && !request.imagePath) {
    throw new Error('Provide a "prompt" (text description) or an "image_path" reference image.')
  }
  const dir = assetDir(projectPath, request.folder, request.name)

  const params: Record<string, unknown> = {
    EnablePBR: request.enablePBR ?? true,
    FaceCount: Math.min(1_500_000, Math.max(3000, request.faceCount ?? DEFAULT_FACE_COUNT)),
    GenerateType: request.generateType ?? 'Normal'
  }
  // Sketch mode is the only one where a prompt and an image may be combined.
  if (request.imagePath) {
    const imageAbs = resolve(projectPath, request.imagePath)
    if (!imageAbs.startsWith(resolve(projectPath) + sep)) throw new Error('image_path must be inside the project.')
    params.ImageBase64 = (await readFile(imageAbs)).toString('base64')
    if (request.prompt?.trim() && request.generateType === 'Sketch') params.Prompt = request.prompt.trim()
  } else {
    params.Prompt = request.prompt!.trim()
  }

  activeJobs++
  try {
    const { JobId } = await apiCall<{ JobId?: string }>(creds, 'SubmitHunyuanTo3DProJob', params)
    if (!JobId) throw new Error('Tencent HY3D did not return a JobId.')

    const deadline = Date.now() + POLL_BUDGET_MS
    let files3d: File3D[] = []
    for (;;) {
      if (Date.now() > deadline) throw new Error(`3D generation timed out after ${POLL_BUDGET_MS / 60000} minutes (job ${JobId}).`)
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const status = await apiCall<{ Status?: string; ErrorCode?: string; ErrorMessage?: string; ResultFile3Ds?: File3D[] }>(
        creds,
        'QueryHunyuanTo3DProJob',
        { JobId }
      )
      if (status.Status === 'DONE') {
        files3d = status.ResultFile3Ds ?? []
        break
      }
      if (status.Status === 'FAIL') {
        throw new Error(`3D generation failed: ${status.ErrorCode ?? 'unknown'} — ${status.ErrorMessage ?? 'no message'}`)
      }
      // WAIT / RUN → keep polling.
    }
    if (files3d.length === 0) throw new Error('3D generation finished but returned no files.')

    await mkdir(dir.abs, { recursive: true })
    const written: string[] = []
    let previewBase64: string | undefined
    let previewMime: string | undefined
    let turntableBase64: string | undefined
    let turntableMime: string | undefined

    for (const file of files3d) {
      if (!file.Url) continue
      const res = await fetch(file.Url)
      if (!res.ok) throw new Error(`Downloading a generated file failed (HTTP ${res.status}).`)
      const data = Buffer.from(await res.arrayBuffer())
      const type = (file.Type ?? '').toLowerCase()

      if (type === 'gif' || type === 'image') {
        const ext = extensionFromUrl(file.Url, type === 'gif' ? 'gif' : 'png')
        const name = `preview-turntable.${ext}`
        await writeFile(join(dir.abs, name), data)
        written.push(join(dir.rel, name))
        if (!turntableBase64 && IMAGE_MIME[ext]) {
          turntableBase64 = data.toString('base64')
          turntableMime = IMAGE_MIME[ext]
        }
      } else if (data.subarray(0, 4).toString('latin1').startsWith('PK')) {
        // Model archives (OBJ + MTL + textures) arrive zipped.
        const archive = join(dir.abs, '_model.zip')
        await writeFile(archive, data)
        await extractZip(archive, dir.abs)
        await rm(archive, { force: true })
        written.push(dir.rel + sep + '(extracted model files)')
      } else {
        const ext = extensionFromUrl(file.Url, 'glb')
        const name = `${slug(request.name)}.${ext}`
        await writeFile(join(dir.abs, name), data)
        written.push(join(dir.rel, name))
      }

      // A static preview lets the (vision) model check its own output.
      if (file.PreviewImageUrl && !previewBase64) {
        const previewRes = await fetch(file.PreviewImageUrl)
        if (previewRes.ok) {
          const ext = extensionFromUrl(file.PreviewImageUrl, 'png')
          const mime = IMAGE_MIME[ext]
          if (mime && mime !== 'image/gif') {
            const preview = Buffer.from(await previewRes.arrayBuffer())
            const name = `preview.${ext}`
            await writeFile(join(dir.abs, name), preview)
            written.push(join(dir.rel, name))
            previewBase64 = preview.toString('base64')
            previewMime = mime
          }
        }
      }
    }
    return { files: written, previewBase64, previewMime, turntableBase64, turntableMime }
  } finally {
    activeJobs--
  }
}
