import { app } from 'electron'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { credentialFilePaths } from './asset-store'

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
 * Wraps the chat server command in a macOS seatbelt sandbox, inherited by
 * every process it spawns (shell commands, rg, git, the MCP bridge). Two
 * reasons:
 *
 *  - macOS attributes file access by this process tree to GenieEngine, so a
 *    stray `find ~` from the model used to pop "GenieEngine would like to
 *    access your Desktop/Photos/…" TCC dialogs at the user. Seatbelt denies
 *    the access before TCC is ever consulted — no dialog, the command just
 *    gets a permission error the agent can read and route around.
 *  - It is the agent's hard boundary. Codex's own sandbox can't run in here
 *    (seatbelt profiles don't nest — see codex-config.ts), and Codex's would
 *    allow reads everywhere anyway, which is exactly what triggers TCC.
 *
 * The profile allows everything except the user's personal and cloud-synced
 * folders, key credential stores, and the app's own credential files. The
 * project itself is re-allowed even when it lives inside a denied folder
 * (projects commonly sit in Documents; SBPL is last-match-wins), and the
 * app's own files stay readable — the Codex package, MCP bridge, and dev
 * vendor tree live there.
 *
 * "The app's own files" must cover the WHOLE bundle, not just Resources:
 * the MCP bridge runs on the app's own executable (Contents/MacOS, loading
 * Contents/Frameworks), and when the app runs from a DMG mounted under
 * /Volumes — a denied root — the bridge died at dyld time, silently taking
 * every genieengine game tool with it. Electron startup also canonicalizes
 * its own bundle path, stat'ing each ancestor directory (/Volumes, the mount
 * root), so those need metadata-level reads too or ICU init crashes before
 * main(). Metadata only — denied directories still can't be listed or read.
 *
 * `extraReadable` adds directories the command needs beyond the app bundle
 * (the Codex package, when it isn't the bundled one).
 */
export function sandboxCommand(
  command: string,
  args: string[],
  projectPath: string,
  extraReadable: string[] = []
): { command: string; args: string[] } {
  if (process.platform !== 'darwin') return { command, args }
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
  // userData stays readable and writable — Codex keeps its home (sessions,
  // state) there and the MCP bridge reads harness.json from it — but the API
  // keys stored next to them don't.
  const denyFiles = credentialFilePaths()
  const allowRead = [
    ...withRealpath(app.getAppPath()),
    ...withRealpath(process.resourcesPath),
    ...withRealpath(appBundleRoot()),
    ...extraReadable.flatMap(withRealpath)
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
    ...(denyFiles.length ? [`(deny file-read* ${denyFiles.map((p) => `(literal ${sbplPath(p)})`).join(' ')})`] : []),
    `(allow file-read* ${allowRead.map((p) => `(subpath ${sbplPath(p)})`).join(' ')})`,
    `(allow file-read* file-write* ${allowReadWrite.map((p) => `(subpath ${sbplPath(p)})`).join(' ')})`,
    `(allow file-read-metadata ${allowStat.map((p) => `(literal ${sbplPath(p)})`).join(' ')})`
  ].join('\n')
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, command, ...args] }
}
