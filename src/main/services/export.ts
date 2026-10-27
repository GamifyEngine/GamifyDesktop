import { shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExportPlatform, ExportProgress } from '../../shared/types'
import { sendToRenderer } from '../window'
import { resolveGodot } from './binaries'

const pexec = promisify(execFile)

/**
 * Game export: generates export presets for the chosen platforms and runs
 * `godot --headless --export-release` for each. Godot's export templates
 * (~1 GB, all platforms in one archive) are downloaded on first export and
 * installed into Godot's standard templates directory.
 *
 * Desktop + Web exports work out of the box; Android needs the Android SDK
 * and iOS needs Xcode — those surface Godot's own error messages.
 */

/** Where a Godot build's export templates live and come from. */
interface TemplatesSource {
  /** Godot's directory name for them, e.g. "4.7.2.stable" (".mono" suffix for .NET builds). */
  dirName: string
  url: string
}

/**
 * Export templates must match the engine exactly, so they're derived from
 * the binary that will run the export — the bundled engine, or the user's own
 * Godot install if they pointed GenieEngine at one — instead of a pinned
 * version that can drift from it. `--version` prints e.g.
 * "4.7.2.stable.official.a13da4feb" ("4.8.beta1.…" for pre-releases,
 * "….mono.…" for .NET builds).
 */
async function templatesSource(godot: string): Promise<TemplatesSource> {
  const { stdout } = await pexec(godot, ['--headless', '--version'], { timeout: 60_000 })
  const match = /^(\d+\.\d+(?:\.\d+)?)\.([a-z]+\d*)(\.mono)?\./m.exec(stdout)
  if (!match) throw new Error(`Could not read the Godot version (got "${stdout.trim().slice(0, 80)}").`)
  const [, number, status, mono] = match
  const tag = `${number}-${status}`
  const file = `Godot_v${tag}${mono ? '_mono' : ''}_export_templates.tpz`
  // Stable releases are published on the main repo; pre-releases only on godot-builds.
  const repo = status === 'stable' ? 'godotengine/godot' : 'godotengine/godot-builds'
  return {
    dirName: `${number}.${status}${mono ? '.mono' : ''}`,
    url: `https://github.com/${repo}/releases/download/${tag}/${file}`
  }
}

interface PlatformSpec {
  id: ExportPlatform
  presetName: string
  /** Godot's export platform identifier. */
  platform: string
  /** Output file for a given base name. */
  outFile: (name: string) => string
  extraOptions: (slug: string) => string
}

const PLATFORMS: PlatformSpec[] = [
  {
    id: 'windows',
    presetName: 'Windows Desktop',
    platform: 'Windows Desktop',
    outFile: (n) => `${n}.exe`,
    extraOptions: () => ''
  },
  {
    id: 'macos',
    presetName: 'macOS',
    platform: 'macOS',
    outFile: (n) => `${n}.zip`,
    extraOptions: (slug) => `application/bundle_identifier="ai.genieengine.${slug}"\n`
  },
  {
    id: 'linux',
    presetName: 'Linux',
    platform: 'Linux',
    outFile: (n) => `${n}.x86_64`,
    extraOptions: () => ''
  },
  {
    id: 'web',
    presetName: 'Web',
    platform: 'Web',
    outFile: () => `index.html`,
    extraOptions: () => 'variant/thread_support=false\n'
  },
  {
    id: 'android',
    presetName: 'Android',
    platform: 'Android',
    outFile: (n) => `${n}.apk`,
    extraOptions: () => ''
  },
  {
    id: 'ios',
    presetName: 'iOS',
    platform: 'iOS',
    outFile: (n) => `${n}.ipa`,
    extraOptions: (slug) => `application/bundle_identifier="ai.genieengine.${slug}"\n`
  }
]

let exporting = false
let currentChild: ChildProcess | null = null
let cancelRequested = false

function progress(update: ExportProgress): void {
  sendToRenderer('export:progress', update)
}

function templatesDir(source: TemplatesSource): string {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Godot', 'export_templates', source.dirName)
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Godot', 'export_templates', source.dirName)
    default:
      return join(homedir(), '.local', 'share', 'godot', 'export_templates', source.dirName)
  }
}

/**
 * Extract a zip archive with the platform's native tool. Mirrors extract()
 * in scripts/fetch-vendor.mjs (which can't be imported here — it's a
 * postinstall script with top-level side effects). ditto was previously used
 * unconditionally, which broke exports on Windows/Linux.
 * Also used by hy3d.ts for generated-asset archives.
 */
export async function extractZip(archive: string, dest: string): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      // ditto preserves symlinks and permissions (needed for .app templates).
      await pexec('ditto', ['-xk', archive, dest])
      return
    case 'win32':
      // bsdtar (ships with Windows 10 1803+, the oldest Windows Electron
      // supports) extracts zips, and execFile passes the paths as plain args.
      // The previous Expand-Archive command string interpolated `dest`, which
      // hy3d.ts derives from a model-supplied folder name — a `"` or `$()` in
      // it could execute arbitrary PowerShell.
      await pexec('tar', ['-xf', archive, '-C', dest])
      return
    default:
      await pexec('unzip', ['-q', '-o', archive, '-d', dest])
  }
}

/** Download + install the full template set (once per Godot version). */
async function ensureTemplates(godot: string): Promise<void> {
  const source = await templatesSource(godot)
  const dir = templatesDir(source)
  if (existsSync(dir) && (await readdir(dir)).length > 10) return

  progress({ phase: 'templates', message: 'Downloading Godot export templates (~1 GB, one-time)…', percent: 0 })
  const archive = join(tmpdir(), `og-templates-${source.dirName}.tpz`)
  const res = await fetch(source.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Template download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastPercent = -1
  const counter = new (await import('node:stream')).Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      const percent = total ? Math.floor((received / total) * 100) : 0
      if (percent !== lastPercent) {
        lastPercent = percent
        progress({ phase: 'templates', message: 'Downloading Godot export templates…', percent })
      }
      cb(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(archive))
  if (cancelRequested) {
    await rm(archive, { force: true })
    throw new Error('Export cancelled.')
  }

  progress({ phase: 'templates', message: 'Installing export templates…', percent: 100 })
  const extractTo = join(tmpdir(), `og-templates-extract-${Date.now()}`)
  await mkdir(extractTo, { recursive: true })
  // A .tpz is a zip with everything under templates/.
  await extractZip(archive, extractTo)
  await mkdir(join(dir, '..'), { recursive: true })
  await rm(dir, { recursive: true, force: true })
  await rename(join(extractTo, 'templates'), dir)
  await rm(archive, { force: true })
  await rm(extractTo, { recursive: true, force: true })
}

/**
 * macOS (arm64/universal) and mobile exports require the ETC2/ASTC texture
 * import project setting; Godot refuses to export without it. Enable it in
 * project.godot if missing (the same change the Godot editor prompts for).
 */
async function ensureEtc2Astc(projectPath: string): Promise<void> {
  const file = join(projectPath, 'project.godot')
  let src = await readFile(file, 'utf8')
  if (src.includes('import_etc2_astc')) return
  if (/^\[rendering\]$/m.test(src)) {
    src = src.replace(/^\[rendering\]$/m, '[rendering]\n\ntextures/vram_compression/import_etc2_astc=true')
  } else {
    src += '\n[rendering]\n\ntextures/vram_compression/import_etc2_astc=true\n'
  }
  await writeFile(file, src)
}

/**
 * Exported games must never boot on the Godot-logo splash — they should look
 * like the creator's game, not the engine's demo. New projects get these
 * settings from the template (see templates.ts); this covers projects created
 * before that and imported ones. Same semantics as ensureEtc2Astc: a project
 * that already made a splash choice (its own image, or show_image set either
 * way) is deliberate and is left alone.
 */
async function ensureNoBootSplash(projectPath: string): Promise<void> {
  const file = join(projectPath, 'project.godot')
  let src = await readFile(file, 'utf8')
  if (src.includes('boot_splash/image') || src.includes('boot_splash/show_image')) return
  // Boot to plain black (the standard "professional" launch look) instead of
  // Godot's default gray splash background.
  const lines = ['boot_splash/show_image=false']
  if (!src.includes('boot_splash/bg_color')) lines.unshift('boot_splash/bg_color=Color(0, 0, 0, 1)')
  const settings = lines.join('\n')
  if (/^\[application\]$/m.test(src)) {
    src = src.replace(/^\[application\]$/m, `[application]\n\n${settings}`)
  } else {
    src += `\n[application]\n\n${settings}\n`
  }
  await writeFile(file, src)
}

/** A freshly generated preset block; the index is assigned by ensurePresets. */
function presetBlock(spec: PlatformSpec, slug: string): string {
  // The options section must not be empty — Godot's config parser rejects a
  // section header with no keys, so the custom_template lines always stay.
  return `[preset.0]

name="${spec.presetName}"
platform="${spec.platform}"
runnable=true
advanced_options=false
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""
patches=PackedStringArray()
encryption_include_filters=""
encryption_exclude_filters=""
seed=0
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.0.options]

custom_template/debug=""
custom_template/release=""
${spec.extraOptions(slug)}`
}

/**
 * Split an export_presets.cfg into per-preset chunks: each starts at its
 * [preset.N] header and includes the [preset.N.options] section that follows.
 */
function splitPresets(src: string): { name: string; body: string }[] {
  const headerRe = /^\[preset\.\d+\][ \t]*$/gm
  const starts: number[] = []
  let match: RegExpExecArray | null
  while ((match = headerRe.exec(src)) !== null) starts.push(match.index)
  return starts.map((start, i) => {
    const body = src.slice(start, starts[i + 1] ?? src.length)
    return { name: /^name="(.*)"$/m.exec(body)?.[1] ?? '', body }
  })
}

/**
 * Users configure signing, keystores and icons on presets in the Godot
 * editor; regenerating export_presets.cfg wholesale would silently destroy
 * that work. Instead, keep every existing preset exactly as it is and only
 * append generated presets for selected platforms that don't have one yet,
 * renumbering so indices stay sequential (Godot requires preset.0..N).
 * Returns the merged file content, or null when nothing needs to change.
 */
function mergePresets(existing: string, specs: PlatformSpec[], slug: string): string | null {
  const kept = splitPresets(existing)
  const have = new Set(kept.map((p) => p.name))
  const missing = specs.filter((s) => !have.has(s.presetName))
  if (existing !== '' && missing.length === 0) return null

  const blocks = [...kept.map((p) => p.body), ...missing.map((s) => presetBlock(s, slug))]
  let out = '; Export presets — GenieEngine appends missing presets here; existing ones (including\n; presets configured in the Godot editor) are preserved as-is.\n'
  blocks.forEach((body, i) => {
    const renumbered = body.replace(/^\[preset\.\d+(\.options)?\]/gm, (_m, opt: string | undefined) => `[preset.${i}${opt ?? ''}]`)
    out += '\n' + renumbered.trimEnd() + '\n'
  })
  return out
}

async function ensurePresets(projectPath: string, specs: PlatformSpec[], slug: string): Promise<void> {
  const file = join(projectPath, 'export_presets.cfg')
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  } catch {
    // First export for this project — no presets yet.
  }
  const merged = mergePresets(existing, specs, slug)
  if (merged !== null) await writeFile(file, merged)
}

export async function runExport(projectPath: string, baseName: string, platformIds: ExportPlatform[]): Promise<void> {
  if (exporting) throw new Error('An export is already in progress.')
  const godot = await resolveGodot()
  if (!godot) throw new Error('The bundled Godot engine is missing.')

  const specs = PLATFORMS.filter((p) => platformIds.includes(p.id))
  if (specs.length === 0) throw new Error('Select at least one platform.')
  const name = baseName.trim().replace(/[\\/:*?"<>|]/g, '').trim() || 'game'
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game'

  exporting = true
  cancelRequested = false
  try {
    await ensureTemplates(godot)

    await ensureEtc2Astc(projectPath)
    await ensureNoBootSplash(projectPath)
    await ensurePresets(projectPath, specs, slug)

    for (const spec of specs) {
      if (cancelRequested) throw new Error('Export cancelled.')
      progress({ phase: 'platform', platform: spec.id, status: 'exporting' })

      const outDir = join(projectPath, 'exports', spec.id)
      await mkdir(outDir, { recursive: true })
      const outPath = join(outDir, spec.outFile(name))

      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(godot, ['--headless', '--path', projectPath, '--export-release', spec.presetName, outPath], {
          cwd: projectPath,
          env: { ...process.env, PWD: projectPath },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        currentChild = child
        let output = ''
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', (c: string) => (output += c))
        child.stderr?.on('data', (c: string) => (output += c))
        child.once('error', reject)
        child.once('exit', (code) => resolve({ code, output }))
      })
      currentChild = null

      const produced = existsSync(outPath)
      if (result.code === 0 && produced) {
        progress({ phase: 'platform', platform: spec.id, status: 'success', message: outPath })
      } else {
        const errors = result.output
          .split('\n')
          .filter((l) => /error|ERROR|fail/i.test(l))
          .slice(0, 4)
          .join('\n')
        progress({
          phase: 'platform',
          platform: spec.id,
          status: 'error',
          message: errors || `Export failed (exit ${result.code}).`
        })
      }
    }
    progress({ phase: 'done' })
  } catch (err) {
    progress({ phase: 'done', message: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    exporting = false
    currentChild = null
  }
}

export function cancelExport(): void {
  cancelRequested = true
  currentChild?.kill()
}

export function revealExport(path: string): void {
  shell.showItemInFolder(path)
}
