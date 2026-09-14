import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
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
import { getChatModelRefs, setChatModelRefs } from '../state'
import { isGptImageConfigured, saveGptImageConfig } from './gptimage'
import { isHy3dConfigured, saveHy3dCredentials } from './hy3d'
import { shutdownChat } from './opencode'

/**
 * Provider setup for the AI chat, which runs over TWO configurable model
 * slots:
 *
 *  - MEDIUM — the everyday chat/coding model. It is the default for chat
 *    messages and doubles as the global `model` in the OpenCode config, so
 *    OpenCode sessions started outside the app match the app's default.
 *  - LARGE — a heavyweight chat model for tough tasks; the user switches to
 *    it per-conversation from the chat box. Both chat models are named
 *    explicitly on every message the app sends (see sendChatMessage), which
 *    is what lets one conversation continue seamlessly across a switch.
 *
 * Both models MUST accept image input: the chat agent itself reads the
 * images the user attaches and the screenshots the game tools return, and
 * the game-tester subagent (declared under `agent` in the same config, see
 * applyAgentConfig) runs on whichever chat model the current turn uses.
 * Earlier versions kept a third, image-only model slot for the subagents
 * because the chat models of the day could not see; that separation is
 * gone, and the legacy `image` provider / `image-reader` agent entries it
 * left in existing configs are cleaned up here.
 *
 * Every slot has its own endpoint + API key. Keys go into OpenCode's
 * credential store (auth.json, the same file `opencode auth login` writes);
 * endpoints + models go into the global OpenCode config. Slots on the
 * OpenRouter endpoint map to OpenCode's built-in `openrouter` provider
 * (keeping models.dev metadata like context limits, image support and
 * reasoning support); slots on other endpoints get openai-compatible
 * provider entries under the STABLE ids `medium` / `large`, each declaring
 * its model as image-capable. Stable per-slot ids matter: deriving a slot's
 * provider from a comparison with another slot's endpoint once aliased two
 * models onto one credential, so updating one key silently overwrote the
 * other. "Leave the key blank to reuse the Medium key" still works, but as
 * a COPY into the slot's own credential at save time, never as sharing.
 */

export const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1'
export const DEFAULT_MEDIUM_MODEL = 'deepseek/deepseek-v4.1-flash'
export const DEFAULT_LARGE_MODEL = 'moonshotai/kimi-k2.7-code'

/** Provider id OpenCode's built-in OpenRouter support registers under. */
const OPENROUTER_PROVIDER = 'openrouter'
/** Provider id older versions used for a custom main-model endpoint (read for migration only). */
const LEGACY_CUSTOM_PROVIDER = 'custom'
/** Stable per-slot provider ids for models on non-OpenRouter endpoints. */
const MEDIUM_PROVIDER = 'medium'
const LARGE_PROVIDER = 'large'
/** Provider id of the retired image-only slot (removed from configs that still carry it). */
const LEGACY_IMAGE_PROVIDER = 'image'

export const GAME_TESTER_AGENT = 'game-tester'
/** Subagent the retired image slot powered — pointless now that the chat model sees images itself. */
const LEGACY_IMAGE_READER_AGENT = 'image-reader'

function configPath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode.json')
}

function authPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'auth.json')
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Split a stored `provider/model` string into its parts (model may contain '/'). */
function splitModel(full: string): { provider: string; model: string } {
  const slash = full.indexOf('/')
  if (slash === -1) return { provider: OPENROUTER_PROVIDER, model: full }
  return { provider: full.slice(0, slash), model: full.slice(slash + 1) }
}

/** OpenCode's env-var convention for a provider's key, e.g. openrouter → OPENROUTER_API_KEY. */
function providerEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

function isOpenRouterEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname === 'openrouter.ai'
  } catch {
    return false
  }
}

/** A custom-provider entry in the OpenCode config's `provider` map. */
interface ProviderEntry extends Record<string, unknown> {
  options?: { baseURL?: string }
  models?: Record<string, Record<string, unknown>>
}

/**
 * Capability declaration for a model on an openai-compatible provider entry.
 * Such models aren't in models.dev, so without this OpenCode assumes they
 * can't see and swaps every image part (attached references, game
 * screenshots) for an "ERROR: Cannot read image" note before the request.
 */
const IMAGE_CAPABLE_MODEL = { attachment: true, modalities: { input: ['text', 'image'], output: ['text'] } }

const THINKING_MODES: ThinkingMode[] = ['default', 'enabled', 'disabled']
const REASONING_EFFORTS: ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max']

/** Untrusted / stored values → a valid union member ('default' = absent). */
function coerceThinking(value: unknown): ThinkingMode {
  return THINKING_MODES.includes(value as ThinkingMode) ? (value as ThinkingMode) : 'default'
}
function coerceEffort(value: unknown): ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : 'default'
}

/**
 * A slot's thinking/effort choices as per-model `options` for the OpenCode
 * config, or null when both are 'default' (nothing is sent, the model keeps
 * its own defaults). On the wire both spellings become the standard
 * OpenAI-format request fields `thinking: {"type": ...}` / `reasoning_effort`
 * (per https://api-docs.deepseek.com/guides/thinking_mode/) — but the
 * spelling OpenCode wants differs per provider package (probed against
 * OpenCode 1.17.13; 1.18.30 pins the same @ai-sdk/openai-compatible 2.0.41
 * and @openrouter/ai-sdk-provider 2.9.0 and passes per-model options through
 * unchanged under the provider's key — see providerOptions in its
 * provider/transform.ts):
 *
 *  - @ai-sdk/openai-compatible passes `thinking` through verbatim and maps
 *    camelCase `reasoningEffort` → `reasoning_effort` (verbatim snake_case is
 *    dropped);
 *  - @openrouter/ai-sdk-provider (the built-in `openrouter` provider) passes
 *    both keys through verbatim, so snake_case is required.
 */
function wireOptions(
  thinking: ThinkingMode,
  effort: ReasoningEffort,
  pkg: 'openrouter' | 'openai-compatible'
): Record<string, unknown> | null {
  const options: Record<string, unknown> = {}
  if (thinking !== 'default') options.thinking = { type: thinking }
  if (effort !== 'default') options[pkg === 'openrouter' ? 'reasoning_effort' : 'reasoningEffort'] = effort
  return Object.keys(options).length ? options : null
}

function providerEntries(config: Record<string, unknown>): Record<string, ProviderEntry> {
  return (config.provider ?? {}) as Record<string, ProviderEntry>
}

function agentEntries(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (config.agent ?? {}) as Record<string, Record<string, unknown>>
}

/**
 * The stored `provider/model` ref for a chat tier: the app settings first,
 * then the legacy single `config.model` (versions before the Medium/Large
 * split had one main model — presenting it as both tiers keeps an upgraded
 * install behaving exactly as before until the user picks new models), then
 * the tier's default.
 */
function chatModelRef(tier: ChatModelTier, config: Record<string, unknown>): string {
  const stored = getChatModelRefs()[tier]
  if (stored) return stored
  if (typeof config.model === 'string' && config.model) return config.model
  return `${OPENROUTER_PROVIDER}/${tier === 'large' ? DEFAULT_LARGE_MODEL : DEFAULT_MEDIUM_MODEL}`
}

/**
 * The model a chat turn should run on, as the message API wants it. Resolved
 * per send (not cached) so a settings save applies to the very next message.
 */
export async function resolveChatModel(tier: ChatModelTier): Promise<{ providerID: string; modelID: string }> {
  const { provider, model } = splitModel(chatModelRef(tier, await readJson(configPath())))
  return { providerID: provider, modelID: model }
}

/**
 * (Re)writes GenieEngine's managed entries into an OpenCode config object:
 * the game-tester subagent the main coding agent delegates verification to,
 * minus the leftovers of the retired image-only model slot. Called on every
 * setup save AND at app startup (so app updates refresh prompts/tools without
 * the user re-running setup — see ensureOpencodeConfig). Agents and providers
 * under other names are the user's own and are left alone.
 *
 * The subagent declares no `model`: OpenCode then runs it on the model of the
 * turn that spawned it, so the game-tester follows the user's Medium/Large
 * choice automatically and sees screenshots because every chat model must
 * accept image input (see the module comment).
 */
export function applyAgentConfig(config: Record<string, unknown>): void {
  const agents = agentEntries(config)

  // Leftovers of the retired image slot (versions ≤ 0.1.2). The image-reader
  // agent only existed to look at images for a chat model that couldn't; the
  // `image` provider entry only served it. Both would keep working but would
  // point users at a model they no longer configure — and a stale agent
  // `model` on a missing provider fails the pre-flight provider check.
  delete agents[LEGACY_IMAGE_READER_AGENT]
  const providers = providerEntries(config)
  delete providers[LEGACY_IMAGE_PROVIDER]
  // Chat models on custom endpoints saved by those versions were declared
  // text-only (only the image slot declared image input). Upgrade them in
  // place so an existing install starts seeing images on the next launch
  // rather than after the user happens to re-save the settings panel.
  for (const id of [MEDIUM_PROVIDER, LARGE_PROVIDER]) {
    for (const declaration of Object.values(providers[id]?.models ?? {})) Object.assign(declaration, IMAGE_CAPABLE_MODEL)
  }
  if (Object.keys(providers).length) config.provider = providers
  else delete config.provider

  agents[GAME_TESTER_AGENT] = {
    description:
      'Plays and verifies the current game end-to-end: launches it (off-screen on macOS, in ' +
      'a separate window on Windows/Linux), sends scripted input, inspects scene tree / ' +
      'state / logs, and checks screenshots it can actually see. Use it after gameplay or ' +
      'visual changes instead of testing yourself; tell it what changed and what to verify, ' +
      'and it reports what works and what is broken.',
    mode: 'subagent',
    prompt:
      'You are the game-testing specialist inside GenieEngine, an AI game engine for Godot 4 ' +
      'games. You verify that the current project actually works by playing it with the ' +
      'genieengine MCP tools, then report your findings. You never edit files — you test and ' +
      'report so the coding agent can fix.\n\n' +
      'Test procedure:\n' +
      '1. run_game_test — start the game (full engine, real rendering; off-screen on macOS, ' +
      'in its own visible window on Windows/Linux — the tools work the same either way).\n' +
      '2. game_logs — check for script errors right away; a broken launch is the most ' +
      'important finding of all.\n' +
      '3. game_scene_tree — discover node paths; game_state evaluates a GDScript expression ' +
      '(e.g. get_node("/root/Main/Score").text) to assert state cheaply.\n' +
      '4. game_input — drive the game with scripted keys/mouse (DOM-style key names like ' +
      '"ArrowLeft", "Space", "Enter"; mouse coordinates in game-view points from the ' +
      'top-left).\n' +
      '5. game_screenshot — capture and LOOK at the rendered frame: verify sprites and art ' +
      'actually display (no missing textures), the layout and HUD are right, and the visuals ' +
      'match what was asked. You can see images — use screenshots as real evidence.\n' +
      '6. Re-check game_logs after interacting, then ALWAYS stop_game_test when finished, ' +
      'even after failures.\n\n' +
      "Focus on what the caller asked you to verify, but always report launch errors. Read " +
      'the project source when you need to know which keys, nodes, or mechanics to ' +
      'exercise.\n\n' +
      'Budget: each run allows ~40 game tool calls / 8 minutes, and every screenshot makes ' +
      'later steps slower — a good test pass finishes in 10-20 tool calls with 2-4 ' +
      'screenshots. Be decisive: check each behavior once (twice at most for something ' +
      'flaky), and the moment a tool result shows a budget warning, stop probing, call ' +
      'stop_game_test, and write your report from the evidence you have. A finding you ' +
      'cannot fully pin down still belongs in the report — describe what you observed; ' +
      'do not keep re-testing it.\n\n' +
      'Report format: a one-line verdict first (works / broken), then evidence per checked ' +
      'item — the state values you probed, what the screenshots show, and any log errors ' +
      'verbatim. Give concrete reproduction steps for every failure. Do not speculate about ' +
      'fixes; describe precisely what is wrong.',
    // Test-and-report only: reading code is fine, changing it is the main
    // agent's job. Asset generation stays with the main agent too, and the
    // question tool would hang (no UI for subagent questions).
    tools: {
      write: false,
      edit: false,
      patch: false,
      bash: false,
      task: false,
      question: false,
      'genieengine_generate*': false
    }
  }

  config.agent = agents
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const config = await readJson(configPath())
  const providers = providerEntries(config)

  // Configured if the provider has a stored credential OR its env var is set
  // (dev launches inject the key via env; packaged apps rely on auth.json).
  const auth = await readJson(authPath())
  const hasCredential = (provider: string): boolean =>
    provider in auth || !!process.env[providerEnvVar(provider)]
  // A custom provider carries its endpoint in the config; anything else
  // (built-in openrouter, or a provider name from an older version) is shown
  // as the default OpenRouter endpoint.
  const endpointOf = (provider: string): string =>
    providers[provider]?.options?.baseURL || DEFAULT_ENDPOINT

  const slotStatus = (ref: string): ModelSlotStatus => {
    const { provider, model } = splitModel(ref)
    // Thinking/effort live on the model's declaration; either spelling of the
    // effort key may be stored depending on the provider package (see
    // wireOptions), and absence means 'default'.
    const options = (providers[provider]?.models?.[model]?.options ?? {}) as Record<string, unknown>
    return {
      endpoint: endpointOf(provider),
      model,
      configured: hasCredential(provider),
      thinking: coerceThinking((options.thinking as { type?: unknown } | undefined)?.type),
      effort: coerceEffort(options.reasoningEffort ?? options.reasoning_effort)
    }
  }

  const medium = slotStatus(chatModelRef('medium', config))
  const large = slotStatus(chatModelRef('large', config))

  return {
    // The chat dropdown can route any message to either chat model, so the
    // chat only counts as connected once both have usable credentials.
    configured: medium.configured && large.configured,
    medium,
    large,
    hy3dConfigured: await isHy3dConfigured(),
    gptImageConfigured: await isGptImageConfigured()
  }
}

/** One model slot's settings resolved against defaults and stored state. */
interface ResolvedSlot {
  id: ChatModelTier
  title: string
  endpoint: string
  model: string
  /** The stable provider id this slot writes to from now on. */
  providerId: string
  /** Where the slot's credential lived before this save (for migration). */
  prevProviderId: string
  /** The model the slot pointed at before this save (for option cleanup). */
  prevModel: string
  typedKey: string
  thinking: ThinkingMode
  effort: ReasoningEffort
}

/** An auth.json entry, copied verbatim when a credential moves or is shared. */
type AuthEntry = Record<string, unknown>

export async function saveSetup(request: SetupRequest): Promise<void> {
  // Optional asset-generation credentials: only touch a stored credential
  // when the user typed something (blank = unchanged, so re-saving the model
  // doesn't wipe an existing setup).
  if (request.tencentSecretId?.trim() || request.tencentSecretKey?.trim()) {
    await saveHy3dCredentials(request.tencentSecretId ?? '', request.tencentSecretKey ?? '')
  }
  await saveGptImageConfig(request.openaiApiKey ?? '')

  const configFile = configPath()
  await mkdir(join(configFile, '..'), { recursive: true })
  const config = await readJson(configFile)

  const resolve = (
    id: ResolvedSlot['id'],
    title: string,
    req: ModelSlotRequest,
    defaultModel: string,
    prevRef: string
  ): ResolvedSlot => {
    const endpoint = req.endpoint.trim() || DEFAULT_ENDPOINT
    const previous = splitModel(prevRef)
    return {
      id,
      title,
      endpoint,
      model: req.model.trim() || defaultModel,
      // Slots on OpenRouter use the built-in provider (models.dev metadata);
      // anywhere else they get their own stable id (see the module comment).
      providerId: isOpenRouterEndpoint(endpoint) ? OPENROUTER_PROVIDER : id,
      prevProviderId: previous.provider,
      prevModel: previous.model,
      typedKey: req.apiKey.trim(),
      thinking: coerceThinking(req.thinking),
      effort: coerceEffort(req.effort)
    }
  }
  // Order matters twice below: auth writes (first typed key into a shared
  // provider wins) and key sharing (earlier slots donate to later ones).
  const slots = [
    resolve('medium', 'Medium model endpoint', request.medium, DEFAULT_MEDIUM_MODEL, chatModelRef('medium', config)),
    resolve('large', 'Large model endpoint', request.large, DEFAULT_LARGE_MODEL, chatModelRef('large', config))
  ]
  const [medium, large] = slots

  // 1. Credentials → auth.json. Each slot resolves to its OWN entry so no
  //    save can clobber another slot's key (the old shared-slot scheme let
  //    one slot's key update wipe another's credential):
  //     a. a key typed this save wins (first writer for a shared chat id);
  //     b. else an entry already stored under the slot's id is kept as-is;
  //     c. else the entry under the slot's PREVIOUS id is copied over — the
  //        credential follows the slot when its provider id changes but its
  //        endpoint doesn't (upgrade from the legacy `custom` id), instead of
  //        being stranded under the old id. Not on an endpoint change: the
  //        old key belongs to the old service, so the slot must get a fresh
  //        key (typed or shared);
  //     d. else a same-endpoint slot's entry is copied — the "leave blank to
  //        use the Medium key" flow, as a copy rather than an alias.
  const auth = await readJson(authPath())
  const pendingAuth = new Map<string, AuthEntry>()
  const entryFor = (providerId: string): AuthEntry | undefined =>
    pendingAuth.get(providerId) ?? (auth[providerId] as AuthEntry | undefined)
  const hasCredential = (providerId: string): boolean =>
    !!entryFor(providerId) || !!process.env[providerEnvVar(providerId)]
  // What a provider id served BEFORE this save (the entries are rebuilt below).
  const endpointBefore = (providerId: string): string =>
    providerEntries(config)[providerId]?.options?.baseURL || DEFAULT_ENDPOINT

  for (const slot of slots) {
    if (slot.typedKey) {
      if (!pendingAuth.has(slot.providerId)) pendingAuth.set(slot.providerId, { type: 'api', key: slot.typedKey })
      continue
    }
    if (hasCredential(slot.providerId)) continue
    const previous = entryFor(slot.prevProviderId)
    if (previous && endpointBefore(slot.prevProviderId) === slot.endpoint) {
      pendingAuth.set(slot.providerId, { ...previous })
    }
  }
  for (const slot of slots) {
    if (hasCredential(slot.providerId)) continue
    for (const donor of slots) {
      if (donor === slot || donor.endpoint !== slot.endpoint) continue
      const donated = entryFor(donor.providerId)
      if (donated) {
        pendingAuth.set(slot.providerId, { ...donated })
        break
      }
    }
  }
  if (pendingAuth.size) {
    const path = authPath()
    await mkdir(join(path, '..'), { recursive: true })
    for (const [providerId, entry] of pendingAuth) auth[providerId] = entry
    await writeFile(path, JSON.stringify(auth, null, 2))
    await chmod(path, 0o600) // credentials — owner-only
  }

  // 2. Endpoints + models + agents → global OpenCode config (preserving mcp
  //    etc.). config.model tracks the Medium slot: it's the app's default
  //    tier, and it keeps `opencode` runs outside the app on the same model
  //    (in-app sends name their model explicitly per message).
  config.model = `${medium.providerId}/${medium.model}`
  setChatModelRefs({
    medium: `${medium.providerId}/${medium.model}`,
    large: `${large.providerId}/${large.model}`
  })

  const providers = providerEntries(config)
  // Rebuild our provider entries from scratch so stale ones can't shadow
  // anything or confuse a later status read (built-in OpenRouter needs none;
  // `custom` is the pre-Medium/Large id and only ever needs cleaning up; the
  // legacy `image` id goes in applyAgentConfig below).
  delete providers[LEGACY_CUSTOM_PROVIDER]
  delete providers[MEDIUM_PROVIDER]
  delete providers[LARGE_PROVIDER]
  for (const slot of slots) {
    if (slot.providerId === OPENROUTER_PROVIDER) continue
    const options = wireOptions(slot.thinking, slot.effort, 'openai-compatible')
    providers[slot.providerId] = {
      npm: '@ai-sdk/openai-compatible',
      name: slot.title,
      options: { baseURL: slot.endpoint },
      // Models on openai-compatible entries aren't in models.dev, so they
      // must be declared — as image-capable (see IMAGE_CAPABLE_MODEL).
      models: {
        [slot.model]: {
          name: slot.model,
          ...IMAGE_CAPABLE_MODEL,
          ...(options ? { options } : {})
        }
      }
    }
  }

  // Chat slots on the built-in `openrouter` provider carry their
  // thinking/effort options on a partial provider entry merged over the
  // built-in one. The entry may hold the user's own customizations, so only
  // the two managed keys of models our slots point (or pointed) at are
  // touched: strip them everywhere first, then write the current choices.
  // Two slots on the same OpenRouter model share one declaration — the later
  // slot (Large) wins, since per-model options can't differ per message.
  const managedKeys = ['thinking', 'reasoning_effort']
  const managedModels = new Set<string>()
  for (const slot of slots) {
    if (slot.prevProviderId === OPENROUTER_PROVIDER) managedModels.add(slot.prevModel)
    if (slot.providerId === OPENROUTER_PROVIDER) managedModels.add(slot.model)
  }
  const openrouterModels = providers[OPENROUTER_PROVIDER]?.models
  if (openrouterModels) {
    for (const modelId of managedModels) {
      const declaration = openrouterModels[modelId]
      const options = declaration?.options as Record<string, unknown> | undefined
      if (!options) continue
      for (const key of managedKeys) delete options[key]
      if (!Object.keys(options).length) delete declaration.options
      if (!Object.keys(declaration).length) delete openrouterModels[modelId]
    }
    if (!Object.keys(openrouterModels).length) delete providers[OPENROUTER_PROVIDER]?.models
    if (!Object.keys(providers[OPENROUTER_PROVIDER] ?? { keep: 1 }).length) delete providers[OPENROUTER_PROVIDER]
  }
  for (const slot of slots) {
    if (slot.providerId !== OPENROUTER_PROVIDER) continue
    const options = wireOptions(slot.thinking, slot.effort, 'openrouter')
    if (!options) continue
    const entry = (providers[OPENROUTER_PROVIDER] ??= {})
    const models = (entry.models ??= {})
    const declaration = (models[slot.model] ??= {})
    declaration.options = { ...(declaration.options as Record<string, unknown> | undefined), ...options }
  }

  config.provider = providers
  applyAgentConfig(config)

  if (!config.$schema) config.$schema = 'https://opencode.ai/config.json'
  await writeFile(configFile, JSON.stringify(config, null, 2))

  // 3. Drop the stale chat server so the next message picks up the new config.
  shutdownChat()
}
