import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EcsNode } from '../../shared/types'

/**
 * Scans a project for code files carrying the `#=== gamifydesktop ===` header
 * block that the injected agent instructions mandate (the "File headers"
 * section of resources/agent-instructions.md — change the format there and
 * this parser in lockstep) and parses them into nodes for the ECS viewer.
 * Files without a header simply don't appear — the viewer shows the
 * documented graph. Files written before the rename carry the same block
 * under its old name, `#=== genieengine ===`, which is read the same way.
 */

const SKIP_DIRS = new Set(['exports', 'node_modules'])
/** Scanned file extensions and the line-comment prefix their headers use. */
const COMMENT_PREFIX: Record<string, string> = {
  '.gd': '#',
  '.gdshader': '//'
}
/** Sanity bound so a degenerate directory tree can't hang the scan. */
const MAX_FILES = 2000

async function walk(dir: string, rel: string, out: { rel: string; ext: string }[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // unreadable directory — skip it
  }
  for (const entry of entries) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      // Dot-dirs cover .godot/.git/.import; SKIP_DIRS covers the rest.
      if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        await walk(join(dir, entry.name), entryRel, out)
      }
    } else {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      if (ext in COMMENT_PREFIX) out.push({ rel: entryRel, ext })
    }
  }
}

interface ParsedHeader {
  fields: Record<string, string>
  extra: string[]
}

/** Parse the first `#=== gamifydesktop ===` … `#=== /gamifydesktop ===` block (or its pre-rename `genieengine` form). */
function parseHeader(src: string, comment: string): ParsedHeader | null {
  const esc = comment.replace(/\//g, '\\/')
  const block = new RegExp(`^${esc}=== (gamifydesktop|genieengine) ===[ \\t]*\\r?\\n([\\s\\S]*?)^${esc}=== \\/\\1 ===`, 'm').exec(src)
  if (!block) return null
  const fields: Record<string, string> = {}
  const extra: string[] = []
  for (const raw of block[2].split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith(comment)) continue
    const body = line.slice(comment.length).trim()
    const kv = /^(kind|name|summary|uses):\s*(.*)$/.exec(body)
    if (kv) fields[kv[1]] = kv[2].trim()
    else if (body) extra.push(body)
  }
  if (!fields.kind || !fields.name) return null
  return { fields, extra }
}

export async function scanEcs(projectPath: string): Promise<EcsNode[]> {
  const files: { rel: string; ext: string }[] = []
  await walk(projectPath, '', files)

  const nodes: EcsNode[] = []
  await Promise.all(
    files.map(async (file) => {
      let src: string
      try {
        src = await readFile(join(projectPath, file.rel), 'utf8')
      } catch {
        return
      }
      const parsed = parseHeader(src, COMMENT_PREFIX[file.ext])
      if (!parsed) return
      const base = file.rel.slice(file.rel.lastIndexOf('/') + 1)
      const usesRaw = parsed.fields.uses ?? ''
      nodes.push({
        path: file.rel,
        id: base.slice(0, base.lastIndexOf('.')),
        kind: parsed.fields.kind.toLowerCase(),
        name: parsed.fields.name,
        summary: parsed.fields.summary ?? '',
        uses:
          usesRaw.toLowerCase() === 'none'
            ? []
            : usesRaw
                .split(',')
                .map((u) => u.trim().replace(/\.gd$/, ''))
                .filter(Boolean),
        extra: parsed.extra
      })
    })
  )
  nodes.sort((a, b) => a.path.localeCompare(b.path))
  return nodes
}
