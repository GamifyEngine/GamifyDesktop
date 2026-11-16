import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { assetDir, credentialsStore } from './asset-store'

/**
 * OpenAI image generation ("gpt-image") client: generates 2D game art
 * (sprites, icons, UI, textures) straight into the project's assets/ tree.
 * Exposed to the AI as the `generate_2d_asset` MCP tool (test-harness.ts),
 * gated on the user saving an OpenAI API key in the setup panel — same
 * optional-tool pattern as hy3d.ts.
 *
 * Fixed generation profile per product decision: single image, 1024×1024,
 * medium quality, transparent background, PNG. The model is pinned to
 * gpt-image-1.5: gpt-image-2 rejects background=transparent (the API errors),
 * so 1.5 is the newest model that supports transparency, which game sprites
 * need.
 */

export const IMAGE_MODEL = 'gpt-image-2.6-sunburst'
// Overridable for tests/proxies; the OpenAI SDK honors the same variable.
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'

interface GptImageCredentials extends Record<string, string> {
  apiKey: string
}

const store = credentialsStore<GptImageCredentials>('gptimage-credentials.json')

export async function isGptImageConfigured(): Promise<boolean> {
  return store.isConfigured()
}

/**
 * Save the API key — blank keeps the current stored value (the setup panel
 * only reveals the key field when the user asks to change it, so a blank key
 * usually just means "unchanged"). No-ops when nothing is configured yet and
 * no key was provided now.
 */
export async function saveGptImageConfig(apiKey: string): Promise<void> {
  const key = apiKey.trim()
  if (!key) return
  await store.save({ apiKey: key })
}

export interface GenerateImageRequest {
  prompt: string
  /** Destination under assets/, e.g. "entities/e_player" — mirrors the ECS layout. */
  folder: string
  /** Asset name; becomes the containing folder and file base name. */
  name: string
}

export interface GeneratedImage {
  /** Project-relative paths of the files written. */
  files: string[]
  previewBase64: string
  previewMime: string
}

export async function generateImageAsset(projectPath: string, request: GenerateImageRequest): Promise<GeneratedImage> {
  const creds = await store.load()
  if (!creds) throw new Error('OpenAI image generation is not configured. The user can add an API key in the AI settings panel.')
  if (!request.prompt?.trim()) throw new Error('Provide a "prompt" describing the image.')
  const dir = assetDir(projectPath, request.folder, request.name)

  const res = await fetch(`${BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${creds.apiKey}`
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: request.prompt.trim(),
      n: 1,
      size: '1024x1024',
      quality: 'medium',
      background: 'transparent',
      output_format: 'png'
    })
  })
  const body = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string; url?: string }[]
    error?: { message?: string; code?: string }
  } | null
  if (!res.ok || !body) {
    throw new Error(`OpenAI image generation failed (HTTP ${res.status}): ${body?.error?.message ?? 'unexpected response'}`)
  }
  const image = body.data?.[0]
  // gpt-image models return base64 by default; handle a URL defensively.
  let png: Buffer
  if (image?.b64_json) {
    png = Buffer.from(image.b64_json, 'base64')
  } else if (image?.url) {
    const download = await fetch(image.url)
    if (!download.ok) throw new Error(`Downloading the generated image failed (HTTP ${download.status}).`)
    png = Buffer.from(await download.arrayBuffer())
  } else {
    throw new Error('OpenAI returned no image data.')
  }

  await mkdir(dir.abs, { recursive: true })
  // basename, not a '/'-split: dir.rel comes from path.join, which uses '\'
  // on Windows — splitting on '/' would put the whole path into the name.
  const fileName = `${basename(dir.rel)}.png`
  await writeFile(join(dir.abs, fileName), png)

  return {
    files: [join(dir.rel, fileName)],
    previewBase64: png.toString('base64'),
    previewMime: 'image/png'
  }
}
