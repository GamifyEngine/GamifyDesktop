import { exec as dugiteExec } from 'dugite'
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GitChange, GitCommit, GitRemote, GitStatus } from '../../shared/types'
import { findBinary } from './binaries'

const pexec = promisify(execFile)

interface GitOutput {
  stdout: string
  stderr: string
}

/**
 * GamifyDesktop bundles git via dugite, so source control works on machines with
 * no git installed. A system git is still preferred when present because it
 * carries the user's credential helpers (keychain etc.), which makes
 * push/pull to private remotes work seamlessly.
 */
let systemGit: string | null | undefined // undefined = not probed yet

async function resolveSystemGit(): Promise<string | null> {
  if (systemGit !== undefined) return systemGit
  const found = await findBinary('git')
  if (found === '/usr/bin/git' && process.platform === 'darwin') {
    // /usr/bin/git is an Xcode shim that pops an "install developer tools"
    // dialog when the Command Line Tools are missing — only trust it if
    // they are actually installed.
    try {
      await pexec('xcode-select', ['-p'])
    } catch {
      systemGit = null
      return systemGit
    }
  }
  systemGit = found
  return systemGit
}

/** Run git (system install preferred, bundled fallback); throws with git's own error text. */
export async function git(cwd: string, args: string[]): Promise<GitOutput> {
  const sysGit = await resolveSystemGit()
  if (sysGit) {
    try {
      return await pexec(sysGit, args, { cwd, maxBuffer: 16 * 1024 * 1024 })
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string }
      throw new Error((e.stderr || e.stdout || e.message || 'git failed').trim())
    }
  }
  const result = await dugiteExec(args, cwd)
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `git exited with code ${result.exitCode}`).trim())
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  branch: '',
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  remotes: []
}

async function getRemotes(cwd: string): Promise<GitRemote[]> {
  const { stdout } = await git(cwd, ['remote', '-v'])
  const remotes = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\S+)\t(\S+)\s+\(fetch\)$/)
    if (match) remotes.set(match[1], match[2])
  }
  return [...remotes.entries()].map(([name, url]) => ({ name, url }))
}

/**
 * Parse `git status --porcelain=v2 --branch`. v2 is used because it exposes
 * branch/upstream/ahead-behind in one call and its entry format is stable.
 */
export async function status(cwd: string): Promise<GitStatus> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return EMPTY_STATUS
  }

  const { stdout } = await git(cwd, ['status', '--porcelain=v2', '--branch'])
  const result: GitStatus = { ...EMPTY_STATUS, isRepo: true, staged: [], unstaged: [] }

  const addEntry = (x: string, y: string, path: string): void => {
    if (x !== '.') result.staged.push({ path, status: x, staged: true, untracked: false })
    if (y !== '.') result.unstaged.push({ path, status: y, staged: false, untracked: false })
  }

  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      result.branch = line.slice('# branch.head '.length)
    } else if (line.startsWith('# branch.upstream ')) {
      result.upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+) -(\d+)/)
      if (match) {
        result.ahead = Number(match[1])
        result.behind = Number(match[2])
      }
    } else if (line.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = line.split(' ')
      addEntry(fields[1][0], fields[1][1], fields.slice(8).join(' '))
    } else if (line.startsWith('2 ')) {
      // 2 <XY> ... <Xscore> <path>\t<origPath> — show the new path.
      const fields = line.split(' ')
      addEntry(fields[1][0], fields[1][1], fields.slice(9).join(' ').split('\t')[0])
    } else if (line.startsWith('? ')) {
      result.unstaged.push({ path: line.slice(2), status: '?', staged: false, untracked: true })
    }
  }

  result.remotes = await getRemotes(cwd)
  return result
}

export async function init(cwd: string): Promise<void> {
  try {
    await git(cwd, ['init', '-b', 'main'])
  } catch {
    // `-b` requires git >= 2.28; fall back for older installs.
    await git(cwd, ['init'])
  }
}

export async function stage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await git(cwd, ['add', '--', ...paths])
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    await git(cwd, ['rev-parse', '--verify', 'HEAD'])
    await git(cwd, ['restore', '--staged', '--', ...paths])
  } catch {
    // Unborn branch (no commits yet): restore can't resolve HEAD, so drop the
    // entries from the index instead — same effect, files become untracked.
    await git(cwd, ['rm', '--cached', '-r', '--force', '--', ...paths])
  }
}

export async function discard(cwd: string, change: GitChange): Promise<void> {
  if (change.untracked) {
    await rm(join(cwd, change.path), { recursive: true, force: true })
  } else {
    await git(cwd, ['restore', '--', change.path])
  }
}

async function commitIdentityArgs(cwd: string): Promise<string[]> {
  try {
    await git(cwd, ['config', 'user.name'])
    await git(cwd, ['config', 'user.email'])
    return []
  } catch {
    // No git identity configured (typical on a fresh machine using the
    // bundled git). Fall back to a local default so committing works out of
    // the box; users can set their real identity via `git config --global`.
    return ['-c', 'user.name=GamifyDesktop', '-c', 'user.email=gamifydesktop@localhost']
  }
}

export async function commit(cwd: string, message: string): Promise<string> {
  const identity = await commitIdentityArgs(cwd)
  const { stdout } = await git(cwd, [...identity, 'commit', '-m', message])
  return stdout.trim()
}

export async function push(cwd: string): Promise<string> {
  const st = await status(cwd)
  if (st.remotes.length === 0) {
    throw new Error('No remote configured. Add a remote repository URL first.')
  }
  // First push publishes the branch and sets the upstream, like VS Code.
  const args = st.upstream ? ['push'] : ['push', '-u', st.remotes[0].name, 'HEAD']
  const { stdout, stderr } = await git(cwd, args)
  return (stdout + stderr).trim() || 'Pushed.'
}

export async function pull(cwd: string): Promise<string> {
  const { stdout, stderr } = await git(cwd, ['pull'])
  return (stdout + stderr).trim() || 'Pulled.'
}

export async function addRemote(cwd: string, url: string): Promise<void> {
  await git(cwd, ['remote', 'add', 'origin', url])
}

export async function log(cwd: string): Promise<GitCommit[]> {
  try {
    const { stdout } = await git(cwd, ['log', '-n', '15', '--pretty=format:%h%x1f%s'])
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject] = line.split('\x1f')
        return { hash, subject: subject ?? '' }
      })
  } catch {
    // Repos without commits yet have no log.
    return []
  }
}
