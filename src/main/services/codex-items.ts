import type { ChatPartUpdate, ChatToolStatus } from '../../shared/types'

/*
 * The slice of Codex's app-server protocol (0.164) the chat reads, with field
 * names as in `codex app-server generate-ts`. Thread items are a union tagged
 * by `type`; kinds the chat doesn't show are ignored.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- item payloads are open-ended JSON */
export type CodexItem = { type: string; id: string; [field: string]: any }
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface CodexTurnError {
  message: string
  /** A string code ("contextWindowExceeded", "internalServerError", …) or a one-key object. */
  codexErrorInfo: unknown
}

export interface CodexTurn {
  id: string
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  error: CodexTurnError | null
  items?: CodexItem[]
}

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** `/bin/zsh -lc "cmd"` → `cmd`: Codex runs every command through a login shell. */
function stripShellWrapper(command: string): string {
  const match = /^\S*?(?:ba|z)?sh(?:\.exe)?\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(command)
  return match ? match[2].replace(/\\(["\\])/g, '$1') : command
}

/** A shell command as a chip: reads/searches/listings get their own icon, like dedicated tools. */
function commandChip(item: CodexItem): { name: string; title: string } {
  const actions: CodexItem[] = Array.isArray(item.commandActions) ? item.commandActions : []
  if (actions.length === 1) {
    const action = actions[0]
    if (action.type === 'read') return { name: 'read', title: action.path || action.name || '' }
    if (action.type === 'search') return { name: 'grep', title: action.query || action.path || '' }
    if (action.type === 'listFiles') return { name: 'list', title: action.path || '' }
  }
  return { name: 'bash', title: stripShellWrapper(String(item.command ?? '')) }
}

/** The most telling argument of an MCP call, so pending chips aren't blank. */
function argumentsTitle(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  const pick = [a.expression, a.query, a.url, a.name, a.prompt, a.folder].find((v) => typeof v === 'string' && v)
  return typeof pick === 'string' ? pick : ''
}

/** First text block of an MCP result — the bridge puts its error explanation there. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown[] } | null)?.content
  const text = Array.isArray(content) ? content.find((c) => (c as { type?: string })?.type === 'text') : undefined
  return String((text as { text?: string } | undefined)?.text ?? '')
}

const STATUS: Record<string, ChatToolStatus> = {
  inProgress: 'running',
  completed: 'completed',
  failed: 'error',
  declined: 'error',
  interrupted: 'error'
}

/**
 * One thread item as a chat part, or null for kinds the chat doesn't show.
 * The turn is the assistant message (so a turn renders as one reply), the
 * item its part. `completed` says whether this came from item/completed — for
 * items that carry no status of their own.
 */
export function itemToPart(item: CodexItem, turnId: string, completed: boolean): ChatPartUpdate | null {
  const base = { messageID: turnId, partID: `${turnId}:${item.id}` }
  const tool = (
    name: string,
    title: string,
    status: string | undefined,
    error?: string
  ): ChatPartUpdate => {
    const mapped = status ? (STATUS[status] ?? 'running') : completed ? 'completed' : 'running'
    return {
      ...base,
      kind: 'tool',
      tool: {
        name,
        status: mapped,
        title: truncate(title, 200),
        // Why the call failed — shown as a tooltip on the red ✗ chip.
        error: mapped === 'error' ? truncate(error || status || 'failed', 500) : undefined
      }
    }
  }

  switch (item.type) {
    case 'agentMessage':
      return { ...base, kind: 'text', text: String(item.text ?? '') }
    case 'reasoning': {
      // Summaries when the provider gives them, raw reasoning otherwise.
      const summary: string[] = Array.isArray(item.summary) ? item.summary : []
      const content: string[] = Array.isArray(item.content) ? item.content : []
      return { ...base, kind: 'reasoning', text: (summary.length ? summary : content).join('\n\n') }
    }
    case 'commandExecution': {
      const { name, title } = commandChip(item)
      const output = String(item.aggregatedOutput ?? '').trim()
      const error =
        item.status === 'declined'
          ? 'declined'
          : `exit code ${item.exitCode ?? '?'}${output ? `: ${output.slice(-400)}` : ''}`
      return tool(name, title, item.status, error)
    }
    case 'fileChange': {
      const changes: CodexItem[] = Array.isArray(item.changes) ? item.changes : []
      const created = changes.length > 0 && changes.every((c) => c.kind?.type === 'add')
      const first = String(changes[0]?.path ?? '')
      const title = changes.length > 1 ? `${first} (+${changes.length - 1} more)` : first
      return tool(created ? 'write' : 'edit', title, item.status, 'the patch could not be applied')
    }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return tool(
        String(item.tool ?? 'tool'),
        argumentsTitle(item.arguments),
        item.status,
        item.error?.message || resultText(item.result)
      )
    case 'webSearch':
      return tool('websearch', String(item.query ?? item.action?.query ?? ''), undefined)
    case 'imageView':
      return tool('view_image', String(item.path ?? ''), undefined)
    case 'collabAgentToolCall': {
      // spawnAgent → spawn_agent, matching how the model names the tool.
      const name = String(item.tool ?? 'agent').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
      return tool(name, String(item.prompt ?? ''), item.status)
    }
    case 'contextCompaction':
      return tool('compact', 'Summarizing the conversation so far', undefined)
    default:
      return null // user messages, plans, hook prompts, … — not shown as parts
  }
}
