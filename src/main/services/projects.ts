import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProjectInfo } from '../../shared/types'
import { migrateLegacyProjectState } from './chat-history'
import { commit, init, stage } from './git'
import { agentsMd, gitignore, iconSvg, mainGd, mainTscn, projectGodot } from './templates'

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, '')
    .replace(/\s+/g, '-')
}

async function readProjectName(dir: string): Promise<string> {
  try {
    const config = await readFile(join(dir, 'project.godot'), 'utf8')
    const match = config.match(/^config\/name="(.*)"$/m)
    if (match) return match[1]
  } catch {
    // Fall through to the folder name.
  }
  return basename(dir)
}

/** Scaffold a new runnable Godot project and initialize a git repo in it. */
export async function createProject(parentDir: string, name: string): Promise<ProjectInfo> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Project name is required')
  const folder = slugify(trimmed) || 'my-game'
  const dir = join(parentDir, folder)

  if (existsSync(dir) && (await readdir(dir)).length > 0) {
    throw new Error(`Folder already exists and is not empty: ${dir}`)
  }
  await mkdir(dir, { recursive: true })

  await Promise.all([
    writeFile(join(dir, 'project.godot'), projectGodot(trimmed)),
    writeFile(join(dir, 'main.tscn'), mainTscn(trimmed)),
    writeFile(join(dir, 'main.gd'), mainGd(trimmed)),
    writeFile(join(dir, 'icon.svg'), iconSvg()),
    writeFile(join(dir, '.gitignore'), gitignore()),
    writeFile(join(dir, 'AGENTS.md'), agentsMd(trimmed))
  ])

  // Best-effort git setup (uses the git service, which falls back to the
  // bundled git): a failure here should not block project creation — the
  // Git tab surfaces repo state later.
  try {
    await init(dir)
    await stage(dir, ['.'])
    await commit(dir, 'Initial commit — created with GamifyDesktop')
  } catch {
    /* ignore */
  }

  return { path: dir, name: trimmed }
}

/**
 * SHA-256 of every AGENTS.md body (everything after the title line, which
 * carries the project name) that a past GamifyDesktop version scaffolded —
 * rendered from each historical agentsMd() in templates.ts's git history.
 * A body that hash-matches was written by the app and never edited, so
 * refreshAgentsMd may safely replace the file; anything else belongs to the
 * user (or the assistant, or a non-GamifyDesktop project) and is left alone.
 *
 * When agentsMd() changes, add the OUTGOING version's hash here — sha256 of
 * agentsMd('x') after the first newline — or projects created on the old
 * version stop upgrading.
 */
const APP_OWNED_AGENTS_BODY_HASHES = new Set([
  '6ca9e9418bbc5d9af112f7d8aa7ef918c01a969d62eddeaac3317c45a08a7397', // 574f6ac
  'a31c3c8fe7374ddb3e3efac754eab39524889f4acc069233d4ebe4789fa16912', // ff39253
  'f98c390e8acfd8d36df084ff221728005ff0ac593696b25f7e1a4f5f9a64dd31', // 2bbdaf2
  '3dc573637a8d96c53c68e549f6208b8748a142012dae3f446084df8a027bc423', // e335399
  '284f5a01a803bcc0c9ff579df4bc68b20ff0429cfd3a33354f34666dec8ec02b', // f5b27f3
  '0b2bcbb08334ae49e0d55530034895177a6e90c434c9e691eb23e7c425a1f477', // 68e9314
  '8fb4d86fbe7d01774059d6ea857ba35b0a61b182805442b1c9b942fa40918c6b', // c1f0186
  'd724eddeac410d986eeb994df0508ec366bc27b6a544c15091c000584e659d6f', // 48a75b9
  '6d0daa704600515b97ed8755c89af42b1b7d5c8636adb314b2808bfb4b3d1ffe', // 48a75b9 + uncommitted 2026-07 test-budget edits
  '151e4cac9e17ce46067f2848b1df94ce37ed3475bc51a9d4611b1fdb2c33a8ab' // eff525c (last template naming GenieEngine)
])

function agentsBodyHash(content: string): string {
  return createHash('sha256')
    .update(content.slice(content.indexOf('\n') + 1))
    .digest('hex')
}

/**
 * Upgrade a scaffolded AGENTS.md to the current template when the project is
 * opened. Early GamifyDesktop versions froze the full build rules into each
 * project's AGENTS.md; those rules now ship with the app and are injected per
 * chat server (see agentInstructions in codex-config.ts), so a
 * stale copy would sit in the system prompt alongside — and contradict — the
 * injected ones. Only files whose body hash-matches a template the app wrote
 * are replaced; the title line is exempt from the match so a rename doesn't
 * block the upgrade. Best-effort: a failure never blocks opening.
 */
async function refreshAgentsMd(dir: string, name: string): Promise<void> {
  const file = join(dir, 'AGENTS.md')
  try {
    const existing = await readFile(file, 'utf8')
    const desired = agentsMd(name)
    if (existing === desired) return
    const hash = agentsBodyHash(existing)
    if (hash !== agentsBodyHash(desired) && !APP_OWNED_AGENTS_BODY_HASHES.has(hash)) return
    await writeFile(file, desired)
  } catch {
    // Unreadable or missing (imported project, user deleted it) — leave as-is.
  }
}

/** Validate and open an existing Godot project directory. */
export async function openProject(dir: string): Promise<ProjectInfo> {
  if (!existsSync(join(dir, 'project.godot'))) {
    throw new Error(
      'The selected folder is not a Godot project (no project.godot found). ' +
        'Choose a project created with GamifyDesktop or an existing Godot 4 project.'
    )
  }
  const name = await readProjectName(dir)
  await migrateLegacyProjectState(dir)
  await refreshAgentsMd(dir, name)
  return { path: dir, name }
}

export async function projectInfoFor(dir: string): Promise<ProjectInfo> {
  return { path: dir, name: await readProjectName(dir) }
}
