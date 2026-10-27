import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './git'

/**
 * Project snapshots behind the chat's /undo and /redo. Codex can rewind a
 * conversation (thread/revert) but leaves the files a turn changed alone, so
 * the app records the project's state before every turn itself.
 *
 * A snapshot is a git tree object in a private repository under
 * .genieengine/undo/git, used with the project as its work tree: `add -A` +
 * `write-tree` captures the files, `read-tree --reset -u` puts them back
 * (deleting files the snapshot doesn't have, restoring ones it does). The
 * project's own .gitignore applies, so build output and Godot's cache are
 * never captured or touched. It works whether or not the project is a git
 * repository itself and never touches the user's repository, index or
 * history — the private repo has its own index and no refs at all.
 *
 * Unreferenced trees would normally be garbage-collected after two weeks;
 * gc is disabled so an undo point persisted across restarts can't lose its
 * snapshot. The store goes away with the conversation (/clear).
 */

const UNDO_DIR = join('.genieengine', 'undo')

/** Never captured, whatever the project's .gitignore says (imported projects may have none). */
const ALWAYS_EXCLUDED = ['.genieengine/', '.godot/', 'exports/', 'override.cfg', 'genieengine_test_agent.gd']

function gitDir(projectPath: string): string {
  return join(projectPath, UNDO_DIR, 'git')
}

async function snapshotGit(projectPath: string, args: string[]): Promise<string> {
  const dir = gitDir(projectPath)
  if (!existsSync(join(dir, 'HEAD'))) {
    // git creates the repository directory itself, but not missing parents.
    await mkdir(dir, { recursive: true })
    await git(projectPath, ['--git-dir', dir, 'init', '--quiet'])
    // A plain init via --git-dir is bare; the work tree is passed explicitly.
    // autocrlf off so a restore never rewrites line endings on Windows.
    for (const [key, value] of [
      ['core.bare', 'false'],
      ['core.autocrlf', 'false'],
      ['core.longpaths', 'true'],
      ['gc.auto', '0']
    ]) {
      await git(projectPath, ['--git-dir', dir, 'config', key, value])
    }
    await mkdir(join(dir, 'info'), { recursive: true })
    await writeFile(join(dir, 'info', 'exclude'), ALWAYS_EXCLUDED.join('\n') + '\n')
  }
  const { stdout } = await git(projectPath, ['--git-dir', dir, '--work-tree', projectPath, ...args])
  return stdout.trim()
}

/** The project's current files as a tree id. */
export async function captureSnapshot(projectPath: string): Promise<string> {
  await snapshotGit(projectPath, ['add', '--all'])
  return snapshotGit(projectPath, ['write-tree'])
}

/** Make the project's files match a captured tree. */
export async function restoreSnapshot(projectPath: string, tree: string): Promise<void> {
  // Index the current state first: read-tree removes exactly the files that
  // are in the index but not in the target tree, so anything created since
  // the snapshot must be in the index to be cleaned up.
  await snapshotGit(projectPath, ['add', '--all'])
  await snapshotGit(projectPath, ['read-tree', '--reset', '-u', tree])
}

/**
 * Undo bookkeeping for one conversation (Codex thread), persisted so an undo
 * point survives app restarts:
 *  - before: turn id → tree captured right before that turn ran;
 *  - point:  the pending undo point — the conversation is rewound to just
 *            before this turn (applied to Codex on the next send);
 *  - head:   the tree from before the first undo, which a full redo restores.
 */
export interface UndoState {
  threadId: string | null
  before: Record<string, string>
  point: string | null
  head: string | null
}

const EMPTY_STATE: UndoState = { threadId: null, before: {}, point: null, head: null }

function statePath(projectPath: string): string {
  return join(projectPath, UNDO_DIR, 'state.json')
}

/** The project's undo state, reset when it belongs to a different conversation. */
export async function loadUndoState(projectPath: string, threadId: string | null): Promise<UndoState> {
  try {
    const raw = JSON.parse(await readFile(statePath(projectPath), 'utf8')) as Partial<UndoState>
    if (raw.threadId && raw.threadId === threadId) {
      return {
        threadId,
        before: raw.before && typeof raw.before === 'object' ? raw.before : {},
        point: typeof raw.point === 'string' ? raw.point : null,
        head: typeof raw.head === 'string' ? raw.head : null
      }
    }
  } catch {
    // Missing or corrupt — no undo history.
  }
  return { ...EMPTY_STATE, before: {}, threadId }
}

export async function saveUndoState(projectPath: string, state: UndoState): Promise<void> {
  const path = statePath(projectPath)
  await mkdir(join(projectPath, UNDO_DIR), { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(state))
  await rename(`${path}.tmp`, path)
}

/** /clear: the snapshots only mean something for the conversation being forgotten. */
export async function clearUndoHistory(projectPath: string): Promise<void> {
  await rm(join(projectPath, UNDO_DIR), { recursive: true, force: true })
}
