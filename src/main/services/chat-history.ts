import { copyFile, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ChatAttachment } from '../../shared/types'

/**
 * Per-project chat persistence, stored inside the game project under
 * .genieengine/ (gitignored — chat transcripts are personal, never shared):
 *
 * - chat.json           the rendered transcript plus the OpenCode session id,
 *                       restored when the project is reopened. /clear deletes
 *                       it, so a cleared chat stays cleared.
 * - input-history.json  every message the user has sent, for ↑/↓ recall in
 *                       the composer. Intentionally survives /clear.
 * - attachments/        files the user attached to messages: images saved so
 *                       the AI (and its game-tester subagent) can re-open them
 *                       by path in later turns, plus asset uploads
 *                       (zips/folders/models) copied here so the sandboxed
 *                       assistant can reach them at all.
 * - test-shots/         screenshots the AI takes of the running game (written
 *                       by test-harness.ts) — in-project so agents can read
 *                       them without leaving the project directory.
 * - perf.log            frame-rate stats, one line per minute of gameplay
 *                       (written by perf-monitor.ts) — the AI reads it to
 *                       diagnose performance issues.
 *
 * The transcript is stored as the renderer's own message JSON — the main
 * process treats it as opaque (`unknown[]`) and the renderer validates shape
 * on load, so a schema change can never crash the app, only skip restoring.
 * The one exception is loadTranscriptRecap, which best-effort extracts plain
 * text from the saved messages to re-seed a fresh OpenCode session with the
 * conversation the user can still see; every field access there is guarded,
 * so a schema change degrades to "no recap", never a crash.
 */

const STATE_DIR = '.genieengine'
const CHAT_FILE = 'chat.json'
const INPUT_FILE = 'input-history.json'
const ATTACH_DIR = 'attachments'
const MAX_INPUT_ENTRIES = 100

export interface SavedChat {
  sessionID: string | null
  messages: unknown[]
  inputHistory: string[]
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null // missing or corrupt — treated as empty
  }
}

/**
 * Transcripts can be large (they embed screenshots as data URLs); write via
 * temp file + rename so a crash mid-write can't leave corrupt JSON behind.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

/** Projects whose .gitignore already got the .genieengine/ entry this run. */
const ignoreEnsured = new Set<string>()

/**
 * Creates the project's .genieengine/ state dir and keeps it out of both git
 * and Godot. Shared with test-harness.ts, which stores game screenshots here.
 */
export async function ensureProjectStateDir(projectPath: string): Promise<string> {
  const dir = join(projectPath, STATE_DIR)
  await mkdir(dir, { recursive: true })
  if (!ignoreEnsured.has(projectPath)) {
    ignoreEnsured.add(projectPath)
    // New projects get this via the template; this covers projects created
    // before chat persistence existed and imported Godot projects.
    const gitignorePath = join(projectPath, '.gitignore')
    const current = await readFile(gitignorePath, 'utf8').catch(() => '')
    if (!current.split('\n').some((line) => line.trim().replace(/\/$/, '') === STATE_DIR)) {
      const entry = `${current && !current.endsWith('\n') ? '\n' : ''}\n# GenieEngine local state (chat history, attachments, test screenshots)\n${STATE_DIR}/\n`
      await writeFile(gitignorePath, current + entry).catch(() => {})
    }
    // .gdignore makes Godot skip the directory entirely — without it the
    // editor would import attachments/screenshots as game resources (.import
    // sidecars) and drag them into exports.
    await writeFile(join(dir, '.gdignore'), '', { flag: 'wx' }).catch(() => {})
  }
  return dir
}

export async function loadChatState(projectPath: string): Promise<SavedChat> {
  const dir = join(projectPath, STATE_DIR)
  const chat = await readJson<{ sessionID?: unknown; messages?: unknown }>(join(dir, CHAT_FILE))
  const input = await readJson<{ entries?: unknown }>(join(dir, INPUT_FILE))
  return {
    sessionID: typeof chat?.sessionID === 'string' ? chat.sessionID : null,
    messages: Array.isArray(chat?.messages) ? chat.messages : [],
    inputHistory: Array.isArray(input?.entries) ? input.entries.filter((e) => typeof e === 'string') : []
  }
}

export async function saveChatHistory(
  projectPath: string,
  messages: unknown[],
  sessionID: string | null
): Promise<void> {
  const dir = await ensureProjectStateDir(projectPath)
  await writeJsonAtomic(join(dir, CHAT_FILE), { version: 1, sessionID, messages })
}

/**
 * Save variant for when the caller can't vouch for the session id: a debounced
 * save can fire from a project that is no longer active (switch/close races),
 * and stamping `sessionID: null` then would sever the saved transcript from
 * its still-valid conversation. Keep whatever id the file already has.
 */
export async function saveChatHistoryPreservingSession(
  projectPath: string,
  messages: unknown[]
): Promise<void> {
  const existing = await readJson<{ sessionID?: unknown }>(join(projectPath, STATE_DIR, CHAT_FILE))
  const sessionID = typeof existing?.sessionID === 'string' ? existing.sessionID : null
  await saveChatHistory(projectPath, messages, sessionID)
}

export async function appendInputHistory(projectPath: string, entry: string): Promise<void> {
  if (!entry.trim()) return
  const dir = await ensureProjectStateDir(projectPath)
  const path = join(dir, INPUT_FILE)
  const entries = (await readJson<{ entries?: string[] }>(path))?.entries ?? []
  if (entries[entries.length - 1] === entry) return // consecutive repeat
  entries.push(entry)
  await writeJsonAtomic(path, { version: 1, entries: entries.slice(-MAX_INPUT_ENTRIES) })
}

/** /clear: forget the transcript (input history intentionally stays). */
export async function clearChatHistory(projectPath: string): Promise<void> {
  await rm(join(projectPath, STATE_DIR, CHAT_FILE), { force: true })
  // Attachments only exist for the conversation that referenced them — a
  // cleared chat can't reach the old paths, so drop the files with it.
  await rm(join(projectPath, STATE_DIR, ATTACH_DIR), { recursive: true, force: true })
}

// Recap limits: enough for the model to pick the conversation back up, small
// enough that seeding can never itself overflow a context window (~18k chars
// ≈ 4-5k tokens) — critical because the recap's main consumer is the fresh
// session started right after the previous one exceeded the model's limit.
const RECAP_MAX_MESSAGES = 40
const RECAP_MAX_MESSAGE_CHARS = 1500
const RECAP_MAX_TOTAL_CHARS = 18000

/**
 * Plain-text recap of the saved transcript, for re-seeding a NEW OpenCode
 * session when the saved one is gone (deleted storage, stale id) or unusable
 * (context overflow). Without this, the chat window shows the restored
 * conversation while the model starts blank — continuations silently lose
 * all context. Returns null when there is nothing usable to recap.
 *
 * The saved messages are renderer-owned JSON (see header); extraction is
 * best-effort: user text lives in `content`, assistant text in
 * `parts[kind === 'text']`, everything else (tool chips, screenshots, errors)
 * is skipped as noise the model can re-derive from the project files.
 */
export async function loadTranscriptRecap(projectPath: string): Promise<string | null> {
  const { messages } = await loadChatState(projectPath)
  const lines: string[] = []
  for (const item of messages.slice(-RECAP_MAX_MESSAGES)) {
    const m = item as { role?: unknown; content?: unknown; parts?: unknown }
    let text = ''
    if (m.role === 'user') {
      text = typeof m.content === 'string' ? m.content : ''
    } else if (m.role === 'assistant') {
      const parts = Array.isArray(m.parts) ? m.parts : []
      text = parts
        .map((p: { kind?: unknown; text?: unknown }) =>
          p?.kind === 'text' && typeof p.text === 'string' ? p.text : ''
        )
        .join('')
      if (!text && typeof m.content === 'string') text = m.content
    }
    text = text.trim()
    if (!text) continue
    if (text.length > RECAP_MAX_MESSAGE_CHARS) text = `${text.slice(0, RECAP_MAX_MESSAGE_CHARS)} […]`
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  if (lines.length === 0) return null
  let transcript = lines.join('\n\n')
  while (transcript.length > RECAP_MAX_TOTAL_CHARS && lines.length > 1) {
    lines.shift() // drop oldest first — recent turns matter most
    transcript = lines.join('\n\n')
  }
  return (
    '[Restored context: this chat continues an earlier conversation in this project whose ' +
    'assistant session is no longer available. A recap of the recent conversation follows.]\n\n' +
    `${transcript}\n\n` +
    '[End of restored context. Where the recap disagrees with the project files, the files are ' +
    "the source of truth. Now handle the user's message below.]"
  )
}

/**
 * Attachment names come from the user's filesystem — keep a recognizable slug
 * but drop anything path-hostile; callers add a timestamp prefix to de-dupe.
 */
function slugName(name: string, fallback: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 40) || fallback
}

/** The attachments dir, created (with the state dir around it) on demand. */
async function ensureAttachmentsDir(projectPath: string): Promise<string> {
  const dir = join(await ensureProjectStateDir(projectPath), ATTACH_DIR)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Writes message attachments into .genieengine/attachments/ and returns their
 * project-relative paths (POSIX-style, ready for the message text). The image
 * also rides the message as a file part, but the path is what lets the model
 * look at it again in later turns (via the `read` tool) and what lets the
 * game-tester subagent see it: a subagent never sees the parent's message
 * parts — a path handed through the task tool is its only way in.
 */
export async function saveChatAttachments(
  projectPath: string,
  attachments: ChatAttachment[]
): Promise<string[]> {
  if (attachments.length === 0) return []
  const dir = await ensureAttachmentsDir(projectPath)
  const stamp = Date.now()
  const saved: string[] = []
  for (const [i, attachment] of attachments.entries()) {
    const comma = attachment.dataUrl?.indexOf(',') ?? -1
    if (!attachment.dataUrl || comma === -1) continue
    const base = slugName(attachment.name.replace(/\.[^.]*$/, ''), 'image')
    const ext =
      attachment.name.match(/\.([A-Za-z0-9]+)$/)?.[1] ??
      attachment.mime.split('/')[1]?.split('+')[0] ??
      'png'
    const file = `${stamp}-${i}-${base}.${ext}`
    await writeFile(join(dir, file), Buffer.from(attachment.dataUrl.slice(comma + 1), 'base64'))
    saved.push(`${STATE_DIR}/${ATTACH_DIR}/${file}`)
  }
  return saved
}

// Asset uploads are copied wholesale from the user's disk, so unlike inline
// attachments they need real limits: a mis-drop (a whole home folder, a game's
// export directory) must fail fast instead of flooding the project.
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
const MAX_UPLOAD_FILES = 5000
// OS/tooling litter that would only confuse the assistant if it rode along.
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.git', '__MACOSX'])

/**
 * Total size/count of a directory tree, counted the way the copy will see it
 * (junk skipped, symlinks not followed — a link cycle must not hang this).
 * Stops early once past the caps; the exact totals beyond them don't matter.
 */
async function measureTree(path: string): Promise<{ files: number; bytes: number }> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || JUNK_NAMES.has(basename(path))) return { files: 0, bytes: 0 }
  if (!info.isDirectory()) return { files: 1, bytes: info.size }
  let files = 0
  let bytes = 0
  for (const entry of await readdir(path)) {
    const sub = await measureTree(join(path, entry))
    files += sub.files
    bytes += sub.bytes
    if (files > MAX_UPLOAD_FILES || bytes > MAX_UPLOAD_BYTES) break
  }
  return { files, bytes }
}

export interface SavedUpload {
  /** Project-relative POSIX path, ready for the message text. */
  rel: string
  dir: boolean
}

/**
 * Copies path-based asset uploads (zips, folders, binary asset files) into
 * .genieengine/attachments/. The copy — rather than referencing the original
 * location — is what makes the upload usable at all: the assistant's sandbox
 * confines it to the project directory, so a path under ~/Downloads might as
 * well not exist. Throws (with a user-readable message) when a source is
 * unreadable or over the caps: the send must fail loudly rather than tell the
 * model about files that never arrived.
 */
export async function saveChatUploads(
  projectPath: string,
  uploads: ChatAttachment[]
): Promise<SavedUpload[]> {
  if (uploads.length === 0) return []
  const dir = await ensureAttachmentsDir(projectPath)
  const stamp = Date.now()
  const saved: SavedUpload[] = []
  for (const [i, upload] of uploads.entries()) {
    if (!upload.path) continue
    // stat (not lstat): a dropped path that is itself a symlink means the
    // user wants what it points at.
    const info = await stat(upload.path).catch(() => null)
    if (!info) throw new Error(`"${upload.name}" could not be read from ${upload.path}.`)
    if (info.isDirectory()) {
      const { files, bytes } = await measureTree(upload.path)
      if (bytes > MAX_UPLOAD_BYTES || files > MAX_UPLOAD_FILES) {
        throw new Error(
          `The folder "${upload.name}" is too large to attach — uploads are limited to ` +
            `${MAX_UPLOAD_BYTES / 1024 / 1024} MB and ${MAX_UPLOAD_FILES} files.`
        )
      }
      const name = `${stamp}-${i}-${slugName(upload.name, 'folder')}`
      await cp(upload.path, join(dir, name), {
        recursive: true,
        // Symlinks are skipped, not resolved: a link reaching outside the
        // tree would silently defeat the size cap (and the sandbox would
        // refuse the copied link's target anyway).
        filter: async (src) => !JUNK_NAMES.has(basename(src)) && !(await lstat(src)).isSymbolicLink()
      })
      saved.push({ rel: `${STATE_DIR}/${ATTACH_DIR}/${name}`, dir: true })
    } else {
      if (info.size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `"${upload.name}" is too large to attach — uploads are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`
        )
      }
      // Slug the base name but keep the real extension — tools key off it.
      const ext = upload.name.match(/\.([A-Za-z0-9]+)$/)?.[1]
      const base = slugName(upload.name.replace(/\.[^.]*$/, ''), 'upload')
      const name = `${stamp}-${i}-${base}${ext ? `.${ext}` : ''}`
      await copyFile(upload.path, join(dir, name))
      saved.push({ rel: `${STATE_DIR}/${ATTACH_DIR}/${name}`, dir: false })
    }
  }
  return saved
}
