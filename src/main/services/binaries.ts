import { app } from 'electron'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { getSettings } from '../state'

const pexec = promisify(execFile)

let shellPathLoaded = false

/**
 * GUI-launched apps on macOS/Linux inherit a minimal PATH that usually misses
 * user-installed tools (godot, git, code). Pull the real PATH from the
 * user's login shell once at startup so binary resolution behaves like their
 * terminal. Markers guard against rc files printing extra output.
 */
export async function loadShellPath(): Promise<void> {
  if (process.platform === 'win32' || shellPathLoaded) return
  shellPathLoaded = true
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await pexec(shell, ['-ilc', 'echo -n "__OG_PATH__${PATH}__OG_PATH__"'], {
      timeout: 5000
    })
    const match = stdout.match(/__OG_PATH__(.*?)__OG_PATH__/s)
    if (match && match[1].includes('/')) process.env.PATH = match[1]
  } catch {
    // Fall back to the inherited PATH; findBinary also checks common dirs.
  }
}

/** Well-known install locations checked in addition to PATH. */
const EXTRA_DIRS =
  process.platform === 'win32'
    ? []
    : ['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.local', 'bin')]

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a binary by checking explicit candidate paths first, then PATH and
 * common install directories.
 */
export async function findBinary(name: string, candidates: (string | undefined)[] = []): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate && (await isExecutable(candidate))) return candidate
  }
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  const dirs = [...(process.env.PATH || '').split(delimiter), ...EXTRA_DIRS]
  for (const dir of dirs) {
    if (!dir) continue
    for (const n of names) {
      const full = join(dir, n)
      if (await isExecutable(full)) return full
    }
  }
  return null
}

/** On macOS a user picks `Godot.app`; the real binary lives inside the bundle. */
export function normalizeGodotPath(path: string): string {
  if (process.platform === 'darwin' && path.endsWith('.app')) {
    return join(path, 'Contents', 'MacOS', 'Godot')
  }
  return path
}

/**
 * GamifyDesktop ships with its own engines (fetched by scripts/fetch-vendor.mjs).
 * In development they live in <repo>/vendor; in packaged builds
 * electron-builder copies them into the app's resources directory.
 */
function vendorDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'vendor') : join(app.getAppPath(), 'vendor')
}

export function bundledGodotPath(): string {
  switch (process.platform) {
    case 'darwin':
      return join(vendorDir(), 'godot', 'darwin', 'Godot.app', 'Contents', 'MacOS', 'Godot')
    case 'win32':
      return join(vendorDir(), 'godot', 'win32', 'godot.exe')
    default:
      return join(vendorDir(), 'godot', 'linux', 'godot')
  }
}

/** The bundled Codex app-server, inside its package layout (see fetch-vendor.mjs). */
export function bundledCodexPath(): string {
  const bin = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server'
  return join(vendorDir(), 'codex', process.platform, 'bin', bin)
}

// Resolution order: explicit user override → bundled engine → system installs.
// The bundled engine outranks system copies so every GamifyDesktop install runs
// the exact Godot version the app was tested with.
export async function resolveGodot(): Promise<string | null> {
  const settings = getSettings()
  return findBinary('godot', [
    settings.godotPath ? normalizeGodotPath(settings.godotPath) : undefined,
    bundledGodotPath(),
    '/Applications/Godot.app/Contents/MacOS/Godot',
    '/Applications/Godot_mono.app/Contents/MacOS/Godot'
  ])
}

export async function resolveCodex(): Promise<string | null> {
  return findBinary('codex-app-server', [getSettings().codexPath, bundledCodexPath()])
}
