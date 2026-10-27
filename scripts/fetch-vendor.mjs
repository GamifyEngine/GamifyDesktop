#!/usr/bin/env node
/**
 * Downloads the engines GenieEngine ships with — Godot and the Codex app-server
 * — into vendor/ for a target platform. Defaults to the *current* platform and
 * runs automatically on `npm install` (postinstall); idempotent. electron-builder
 * copies vendor/<platform> into that platform's packaged app resources, so
 * installed builds are fully self-contained.
 *
 * To stage another platform's binaries for cross-building (e.g. building the
 * Windows or Linux installer from macOS), pass --platform= and --arch=:
 *   node scripts/fetch-vendor.mjs --platform=win32 --arch=x64
 *   node scripts/fetch-vendor.mjs --platform=linux --arch=x64
 * Extraction only needs tools available on the *host* (tar/ditto/unzip), not
 * the target platform, so this works cross-platform from a POSIX host.
 *
 * Versions are pinned so every build bundles exactly what was tested. Each
 * target directory carries a `.version` stamp of what it holds, so bumping a
 * pin here replaces the stale binaries on the next run instead of silently
 * keeping the old ones (which is what an existence-only check used to do).
 * (Git is bundled separately via the `dugite` npm dependency.)
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'vendor')

// The app reads the bundled engine's version from the binary itself (export
// templates must match it — see templatesSource in export.ts), so this pin is
// the only place to bump Godot.
const GODOT_VERSION = '4.7.2'
const CODEX_VERSION = '0.164.0'

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`))
  return arg ? arg.slice(flag.length + 3) : undefined
}

const platform = argValue('platform') ?? process.platform
const arch = (argValue('arch') ?? process.arch) === 'arm64' ? 'arm64' : 'x64'
// Extraction tool is chosen by the *host* OS (what can actually run these
// commands), independent of which platform's binaries we're fetching.
const host = process.platform

function godotTarget() {
  const base = `https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable`
  if (platform === 'darwin') {
    return {
      url: `${base}_macos.universal.zip`,
      version: GODOT_VERSION,
      dir: join(VENDOR, 'godot', 'darwin'),
      check: join(VENDOR, 'godot', 'darwin', 'Godot.app', 'Contents', 'MacOS', 'Godot')
    }
  }
  if (platform === 'win32') {
    const asset = arch === 'arm64' ? '_windows_arm64.exe.zip' : '_win64.exe.zip'
    return {
      url: `${base}${asset}`,
      version: GODOT_VERSION,
      dir: join(VENDOR, 'godot', 'win32'),
      check: join(VENDOR, 'godot', 'win32', 'godot.exe'),
      renameTo: 'godot.exe'
    }
  }
  const asset = arch === 'arm64' ? '_linux.arm64.zip' : '_linux.x86_64.zip'
  return {
    url: `${base}${asset}`,
    version: GODOT_VERSION,
    dir: join(VENDOR, 'godot', 'linux'),
    check: join(VENDOR, 'godot', 'linux', 'godot'),
    renameTo: 'godot'
  }
}

/**
 * koffi's prebuilt Windows binary, staged for cross-building the Windows
 * installer from a non-Windows host. npm only installs the optional
 * @koromix/koffi-* package matching the *host* platform, so the win32 build
 * (needed by src/main/services/winhost.ts for in-app game embedding) must be
 * fetched explicitly; electron-builder ships it to resources/koffi/, one of
 * koffi's built-in search paths. Version comes from the installed koffi so
 * the native binary can never drift from the JS that loads it.
 */
function koffiTarget() {
  const version = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'koffi', 'package.json'), 'utf8')).version
  const pkg = `koffi-win32-${arch}`
  const triplet = `win32_${arch}`
  const dir = join(VENDOR, 'koffi', 'win32')
  return {
    url: `https://registry.npmjs.org/@koromix/${pkg}/-/${pkg}-${version}.tgz`,
    version,
    dir,
    check: join(dir, triplet, 'koffi.node'),
    // npm tarballs root everything under package/; keep just the triplet dir
    // koffi's loader looks for, and only the .node inside it (the tarball
    // also carries .lib/.exp linker artifacts the app never needs).
    // Receives the directory the archive was extracted into (a staging dir
    // while fetching — see fetchTarget), so it must not close over `dir`.
    finalize: (dir) => {
      rmSync(join(dir, triplet), { recursive: true, force: true })
      renameSync(join(dir, 'package', triplet), join(dir, triplet))
      rmSync(join(dir, 'package'), { recursive: true, force: true })
      for (const f of readdirSync(join(dir, triplet))) {
        if (f !== 'koffi.node') rmSync(join(dir, triplet, f), { force: true })
      }
    }
  }
}

/**
 * Codex's app-server package — the official distribution for embedding Codex
 * in another app (IDE extensions use the same one). The archive extracts to
 * the canonical package layout, kept intact because the binary resolves its
 * helpers relative to itself: bin/codex-app-server (+ codex-code-mode-host),
 * codex-path/rg (ripgrep, which Codex puts on the agent's PATH) and
 * codex-resources/ (bwrap on Linux, sandbox helpers on Windows).
 */
function codexTarget() {
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
  const triple =
    platform === 'darwin'
      ? `${cpu}-apple-darwin`
      : platform === 'win32'
        ? `${cpu}-pc-windows-msvc`
        : `${cpu}-unknown-linux-musl`
  const dir = join(VENDOR, 'codex', platform)
  return {
    url: `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-app-server-package-${triple}.tar.gz`,
    version: CODEX_VERSION,
    dir,
    check: join(dir, 'bin', platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server')
  }
}

async function download(url, dest) {
  console.log(`  downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

function extract(archive, dir) {
  if (archive.endsWith('.tar.gz') || archive.endsWith('.tgz')) {
    execFileSync('tar', ['-xzf', archive, '-C', dir])
  } else if (host === 'darwin') {
    // ditto preserves .app bundle structure, symlinks and permissions
    // (also handles plain zips fine when fetching a non-mac target).
    execFileSync('ditto', ['-xk', archive, dir])
  } else if (host === 'win32') {
    // bsdtar (Windows 10 1803+) extracts zips; paths are plain args, never
    // interpolated into a PowerShell command string (same fix as export.ts).
    execFileSync('tar', ['-xf', archive, '-C', dir])
  } else {
    execFileSync('unzip', ['-q', '-o', archive, '-d', dir])
  }
}

/** What a target directory currently holds, as `<version> <arch>` (arch matters when cross-fetching). */
function stampFor(target) {
  return `${target.version} ${arch}`
}

async function fetchTarget(label, target) {
  const stampFile = join(target.dir, '.version')
  const stamp = existsSync(stampFile) ? readFileSync(stampFile, 'utf8').trim() : null
  if (existsSync(target.check) && stamp === stampFor(target)) {
    console.log(`✓ ${label} already present`)
    return
  }
  const replacing = existsSync(target.dir)
  console.log(replacing ? `… replacing ${label} (had ${stamp ?? 'an unversioned copy'})` : `… fetching ${label}`)

  // Download and extract into a staging directory next to the real one and
  // swap only once everything checks out: a failed or interrupted download
  // then leaves the previous copy in place (an earlier version deleted the
  // old directory first and left vendor/ empty when the network dropped).
  // Targets are expressed relative to target.dir, so re-point them at the
  // staging dir for the duration.
  const finalDir = target.dir
  const stagingDir = `${finalDir}.staging`
  const staged = {
    ...target,
    dir: stagingDir,
    check: join(stagingDir, relative(finalDir, target.check)),
    finalize: target.finalize ? () => target.finalize(stagingDir) : undefined
  }
  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })
  // Preserve the real extension so extract() can tell a gzip tarball from a
  // .zip — matters once we're fetching non-host targets (e.g. Linux's .tar.gz
  // or npm's .tgz from macOS).
  const gzipTarball = target.url.endsWith('.tar.gz') || target.url.endsWith('.tgz')
  const archive = join(stagingDir, gzipTarball ? '_download.tgz' : '_download.zip')
  try {
    await download(target.url, archive)
    extract(archive, stagingDir)
    rmSync(archive, { force: true })
    if (staged.renameTo) {
      // Godot archives contain a versioned binary name; normalize it so the
      // app can resolve it without knowing the bundled version.
      const extracted = readdirSync(stagingDir).find(
        (f) => f.startsWith('Godot_v') && !f.endsWith('_console.exe') && !f.endsWith('.tmp')
      )
      if (extracted) renameSync(join(stagingDir, extracted), join(stagingDir, staged.renameTo))
    }
    if (staged.finalize) staged.finalize()
    // Executable bit is meaningless on Windows but harmless to set from a
    // POSIX host when cross-fetching the win32 target's binaries.
    if (host !== 'win32' && existsSync(staged.check)) chmodSync(staged.check, 0o755)
    if (!existsSync(staged.check)) throw new Error(`extraction did not produce ${staged.check}`)
    writeFileSync(join(stagingDir, '.version'), stampFor(target))
    rmSync(finalDir, { recursive: true, force: true })
    renameSync(stagingDir, finalDir)
    console.log(`✓ ${label} ready`)
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

try {
  await fetchTarget(`Godot ${GODOT_VERSION}`, godotTarget())
  await fetchTarget(`Codex ${CODEX_VERSION}`, codexTarget())
  // The assistant used to run on the OpenCode CLI (≤ 0.1.2). Nothing reads
  // or packages vendor/opencode any more, so don't leave its binaries
  // behind in existing checkouts.
  rmSync(join(VENDOR, 'opencode'), { recursive: true, force: true })
  // Only the win32 target needs a staged koffi binary — on the host platform
  // npm installs the right one into node_modules, and only Windows uses FFI.
  if (platform === 'win32') await fetchTarget('koffi win32 prebuild', koffiTarget())
} catch (err) {
  // Don't fail `npm install` when offline — the app degrades gracefully and
  // `npm run setup` can be re-run later.
  console.warn(`\n⚠ vendor fetch failed: ${err.message}`)
  console.warn('  GenieEngine needs these bundled engines; re-run with: npm run setup\n')
}
