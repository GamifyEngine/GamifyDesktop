import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ChatModelTier,
  ModelSlotRequest,
  ModelSlotStatus,
  ReasoningEffort,
  SetupRequest,
  SetupStatus,
  ThinkingMode
} from '../../shared/types'
import { getChatSlotSettings, getSettings, setChatSlotSettings, type ChatSlotSettings } from '../state'
import { credentialsStore } from './asset-store'
import { isGptImageConfigured, saveGptImageConfig } from './gptimage'
import { isHy3dConfigured, saveHy3dCredentials } from './hy3d'

/**
 * Model setup for the AI chat, which runs over TWO configurable model slots:
 *
 *  - MEDIUM — the everyday chat/coding model, the default for chat messages.
 *  - LARGE — a heavyweight model for tough tasks; the user switches to it
 *    per message from the chat box. Each turn names its slot (see
 *    sendChatMessage in codex.ts), so one conversation continues seamlessly
 *    across a switch — even when the slots live on different endpoints.
 *
 * Both models MUST accept image input: the agent itself reads the images the
 * user attaches and the screenshots the game tools return, and the
 * game-tester subagent runs on whichever slot the current turn uses.
 *
 * Every slot has its own endpoint, model, thinking/effort choice and API key.
 * Endpoints must speak the OpenAI Responses API — the only wire protocol
 * Codex supports. Settings live in GenieEngine's settings file; keys live in
 * one owner-only credential file per slot. Neither is ever handed to Codex:
 * Codex talks to the local model proxy, which looks the slot up per request
 * and attaches the key itself (see model-proxy.ts), so the agent's shell
 * commands can never read a key. Per-slot files also mean saving one slot can
 * never clobber another's key; "leave the key blank to reuse the Medium key"
 * still works, as a COPY into the slot's own file at save time.
 */

export const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1'
export const DEFAULT_MEDIUM_MODEL = 'deepseek/deepseek-v4.1-flash'
export const DEFAULT_LARGE_MODEL = 'moonshotai/kimi-k2.7-code'

const TIERS: ChatModelTier[] = ['medium', 'large']

const SLOT_DEFAULTS: Record<ChatModelTier, ChatSlotSettings> = {
  medium: { endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MEDIUM_MODEL, thinking: 'default', effort: 'default' },
  large: { endpoint: DEFAULT_ENDPOINT, model: DEFAULT_LARGE_MODEL, thinking: 'default', effort: 'default' }
}

const credentials: Record<ChatModelTier, ReturnType<typeof credentialsStore<{ apiKey: string }>>> = {
  medium: credentialsStore<{ apiKey: string }>('chat-medium-credentials.json'),
  large: credentialsStore<{ apiKey: string }>('chat-large-credentials.json')
}

const THINKING_MODES: ThinkingMode[] = ['default', 'enabled', 'disabled']
const REASONING_EFFORTS: ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max']

/** Untrusted / stored values → a valid union member ('default' = absent). */
function coerceThinking(value: unknown): ThinkingMode {
  return THINKING_MODES.includes(value as ThinkingMode) ? (value as ThinkingMode) : 'default'
}
function coerceEffort(value: unknown): ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : 'default'
}

export function isOpenRouterEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname === 'openrouter.ai'
  } catch {
    return false
  }
}

/** Trailing slashes don't make a different endpoint (the key still belongs to it). */
function sameEndpoint(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')
}

/** A slot's settings, with defaults filled in for anything never saved. */
function slotSettings(tier: ChatModelTier): ChatSlotSettings {
  const stored = getChatSlotSettings()?.[tier]
  const defaults = SLOT_DEFAULTS[tier]
  return {
    endpoint: stored?.endpoint || defaults.endpoint,
    model: stored?.model || defaults.model,
    thinking: coerceThinking(stored?.thinking),
    effort: coerceEffort(stored?.effort)
  }
}

/**
 * The key a slot authenticates with: its stored key, else OPENROUTER_API_KEY
 * from the environment for OpenRouter endpoints (how development launches
 * inject a key without saving it). Null = not connected.
 */
async function slotKey(tier: ChatModelTier, endpoint: string): Promise<string | null> {
  const stored = (await credentials[tier].load())?.apiKey
  if (stored) return stored
  return (isOpenRouterEndpoint(endpoint) && process.env.OPENROUTER_API_KEY) || null
}

export interface ResolvedChatSlot extends ChatSlotSettings {
  apiKey: string | null
}

/**
 * Everything needed to send a request on a slot. Read fresh on every call (it
 * is two small files), so a settings save applies to the very next request —
 * no chat-server restart, and no mid-turn interruption.
 */
export async function resolveChatSlot(tier: ChatModelTier): Promise<ResolvedChatSlot> {
  const settings = slotSettings(tier)
  return { ...settings, apiKey: await slotKey(tier, settings.endpoint) }
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const slotStatus = async (tier: ChatModelTier): Promise<ModelSlotStatus> => {
    const slot = await resolveChatSlot(tier)
    return {
      endpoint: slot.endpoint,
      model: slot.model,
      configured: slot.apiKey !== null,
      thinking: slot.thinking,
      effort: slot.effort
    }
  }
  const medium = await slotStatus('medium')
  const large = await slotStatus('large')
  return {
    // The chat dropdown can route any message to either slot, so the chat
    // only counts as connected once both have usable credentials.
    configured: medium.configured && large.configured,
    medium,
    large,
    hy3dConfigured: await isHy3dConfigured(),
    gptImageConfigured: await isGptImageConfigured()
  }
}

export async function saveSetup(request: SetupRequest): Promise<void> {
  // Optional asset-generation credentials: only touch a stored credential
  // when the user typed something (blank = unchanged, so re-saving the model
  // doesn't wipe an existing setup).
  if (request.tencentSecretId?.trim() || request.tencentSecretKey?.trim()) {
    await saveHy3dCredentials(request.tencentSecretId ?? '', request.tencentSecretKey ?? '')
  }
  await saveGptImageConfig(request.openaiApiKey ?? '')

  const requests: Record<ChatModelTier, ModelSlotRequest> = { medium: request.medium, large: request.large }
  const next = {} as Record<ChatModelTier, ChatSlotSettings>
  // Each slot's key after this save: a key typed now wins; otherwise a stored
  // key survives only while its endpoint is unchanged (a key belongs to the
  // service it was entered for). Null = needs a donor (below).
  const keys = {} as Record<ChatModelTier, string | null>
  for (const tier of TIERS) {
    const req = requests[tier]
    const before = slotSettings(tier)
    next[tier] = {
      endpoint: req.endpoint.trim() || DEFAULT_ENDPOINT,
      model: req.model.trim() || SLOT_DEFAULTS[tier].model,
      thinking: coerceThinking(req.thinking),
      effort: coerceEffort(req.effort)
    }
    const stored = (await credentials[tier].load())?.apiKey ?? null
    keys[tier] = req.apiKey.trim() || (sameEndpoint(before.endpoint, next[tier].endpoint) ? stored : null)
  }
  // "Leave blank to use the Medium key": a keyless slot on the same endpoint
  // as a slot that has one gets a copy (earlier slots donate to later ones).
  for (const tier of TIERS) {
    if (keys[tier]) continue
    const donor = TIERS.find((other) => other !== tier && keys[other] && sameEndpoint(next[other].endpoint, next[tier].endpoint))
    if (donor) keys[tier] = keys[donor]
  }

  setChatSlotSettings(next)
  for (const tier of TIERS) {
    const key = keys[tier]
    if (key) await credentials[tier].save({ apiKey: key })
    else await credentials[tier].clear()
  }
}

/**
 * One-time import of a setup made by versions ≤ 0.1.2, which ran the
 * assistant on OpenCode: slot models were `provider/model` refs in our
 * settings (or OpenCode's single global `model`), endpoints and per-model
 * thinking/effort options lived in ~/.config/opencode/opencode.json, and keys
 * in OpenCode's auth.json. Without this, every upgraded user would land on
 * the "Connect your AI assistant" screen and have to re-enter their keys.
 *
 * Best-effort and read-only towards OpenCode's files (the user may still use
 * OpenCode itself). Runs at most once: afterwards chatSlots is set, even when
 * there was nothing to import.
 */
export async function migrateLegacySetup(): Promise<void> {
  if (getChatSlotSettings()) return
  const readJson = async (path: string): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const config = await readJson(join(homedir(), '.config', 'opencode', 'opencode.json'))
  const auth = await readJson(
    join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'auth.json')
  )
  type LegacyProvider = { options?: { baseURL?: string }; models?: Record<string, { options?: Record<string, unknown> }> }
  const providers = (config.provider ?? {}) as Record<string, LegacyProvider>
  const legacyRefs = getSettings().chatModels ?? {}

  const slots = {} as Record<ChatModelTier, ChatSlotSettings>
  for (const tier of TIERS) {
    const ref = legacyRefs[tier] || (typeof config.model === 'string' ? config.model : '')
    if (!ref) {
      slots[tier] = SLOT_DEFAULTS[tier]
      continue
    }
    // `provider/model`, where the model itself may contain '/' (OpenRouter slugs).
    const slash = ref.indexOf('/')
    const provider = slash === -1 ? 'openrouter' : ref.slice(0, slash)
    const model = slash === -1 ? ref : ref.slice(slash + 1)
    const options = providers[provider]?.models?.[model]?.options ?? {}
    slots[tier] = {
      // Providers without a baseURL were OpenCode's built-in openrouter.
      endpoint: providers[provider]?.options?.baseURL || DEFAULT_ENDPOINT,
      model,
      thinking: coerceThinking((options.thinking as { type?: unknown } | undefined)?.type),
      effort: coerceEffort(options.reasoningEffort ?? options.reasoning_effort)
    }
    const key = (auth[provider] as { type?: string; key?: string } | undefined)?.key
    if (typeof key === 'string' && key && !(await credentials[tier].load())) {
      await credentials[tier].save({ apiKey: key })
    }
  }
  setChatSlotSettings(slots)
}
