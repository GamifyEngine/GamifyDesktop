import { useState } from 'react'
import type {
  ChatModelTier,
  ModelSlotRequest,
  ModelSlotStatus,
  ReasoningEffort,
  SetupStatus,
  ThinkingMode
} from '../../../shared/types'
import { SparkIcon, XIcon } from './Icons'

interface Props {
  status: SetupStatus
  onConfigured: (status: SetupStatus) => void
  /** Present when the panel was opened from the gear (already configured) — shows a close button. */
  onClose?: () => void
}

type SetupTab = 'agent' | '2d' | '3d'

const TABS: { id: SetupTab; label: string }[] = [
  { id: 'agent', label: 'Models' },
  { id: '2d', label: '2D Asset Generation (Optional)' },
  { id: '3d', label: '3D Asset Generation (Optional)' }
]

/** Mirrors the main process default — used to tell "same endpoint" from "own endpoint". */
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1'

type SlotId = ChatModelTier

/**
 * The two model sections on the Models tab, in display (and key-sharing donor)
 * order. Placeholders mirror the main-process defaults (chat-setup.ts).
 */
const MODEL_SLOTS: { id: SlotId; title: string; hint: string; modelPlaceholder: string }[] = [
  {
    id: 'medium',
    title: 'Chat model — Medium',
    hint: 'The everyday model that plans and writes your game’s code, reads the images you attach, and play-tests your game with screenshots — so it must accept image input. Any endpoint that speaks the OpenAI Responses API works — OpenRouter does.',
    modelPlaceholder: 'deepseek/deepseek-v4.1-flash'
  },
  {
    id: 'large',
    title: 'Chat model — Large',
    hint: 'A heavyweight model for tough tasks that need extra juice — switch to it from the dropdown in the chat box. Usually slower, and may cost more per message. Must accept image input too.',
    modelPlaceholder: 'moonshotai/kimi-k2.7-code'
  }
]

/** One model section's editable state (its key input stays hidden until revealed). */
interface SlotState {
  endpoint: string
  model: string
  apiKey: string
  thinking: ThinkingMode
  effort: ReasoningEffort
  /** True once the user asked to change an already-stored key. */
  keyRevealed: boolean
}

function initSlot(stored: ModelSlotStatus): SlotState {
  // An already-configured credential starts hidden behind a button — the
  // field only appears once the user explicitly asks to change it, so
  // opening the panel and hitting Save can never blank out a stored key.
  return {
    endpoint: stored.endpoint,
    model: stored.model,
    apiKey: '',
    thinking: stored.thinking,
    effort: stored.effort,
    keyRevealed: !stored.configured
  }
}

const THINKING_CHOICES: { value: ThinkingMode; label: string }[] = [
  { value: 'default', label: 'Default (model decides)' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' }
]

const EFFORT_CHOICES: { value: ReasoningEffort; label: string }[] = [
  { value: 'default', label: 'Default (model decides)' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' }
]

/**
 * Stands in for a credential input once it's already configured, so a
 * stored key is never blanked out by opening the panel and hitting Save —
 * the actual field only appears once the user asks to change it.
 */
function ConfiguredButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="btn btn-ghost setup-configured-btn" onClick={onClick}>
      Already configured. Click to update.
    </button>
  )
}

/**
 * One model's connection settings: endpoint + model + API key. The Models tab
 * shows two — the Medium and Large chat models.
 */
function ModelSection(props: {
  title: string
  hint: string
  endpoint: string
  onEndpoint: (v: string) => void
  model: string
  onModel: (v: string) => void
  modelPlaceholder: string
  thinking: ThinkingMode
  onThinking: (v: ThinkingMode) => void
  effort: ReasoningEffort
  onEffort: (v: ReasoningEffort) => void
  apiKey: string
  onApiKey: (v: string) => void
  keyPlaceholder: string
  keyHint?: string
  /** True while a stored key stays hidden behind the "already configured" button. */
  keyHidden: boolean
  /** Focus the key input when it appears (i.e. right after the reveal click). */
  keyAutoFocus?: boolean
  onRevealKey: () => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <div className="setup-section">
      <div>
        <span className="setup-section-title">{props.title}</span>
        <p className="setup-hint">{props.hint}</p>
      </div>

      <label className="setup-field">
        <span className="setup-label">API endpoint</span>
        <input
          className="text-input"
          value={props.endpoint}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => props.onEndpoint(e.target.value)}
          placeholder={OPENROUTER_ENDPOINT}
        />
      </label>

      <label className="setup-field">
        <span className="setup-label">Model</span>
        <input
          className="text-input"
          value={props.model}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => props.onModel(e.target.value)}
          placeholder={props.modelPlaceholder}
        />
      </label>

      <div className="setup-field-row">
        <label
          className="setup-field"
          title="Whether the model thinks before answering — sent as OpenRouter's `reasoning.enabled` (a DeepSeek-style `thinking` field on other endpoints). Default sends nothing."
        >
          <span className="setup-label">Thinking</span>
          <select
            className="setup-select"
            value={props.thinking}
            onChange={(e) => props.onThinking(e.target.value as ThinkingMode)}
          >
            {THINKING_CHOICES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="setup-field"
          title="How hard the model thinks — sent as the Responses API's `reasoning.effort` field. Default sends nothing; not every model accepts every level."
        >
          <span className="setup-label">Reasoning effort</span>
          <select
            className="setup-select"
            value={props.effort}
            onChange={(e) => props.onEffort(e.target.value as ReasoningEffort)}
          >
            {EFFORT_CHOICES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="setup-field">
        <span className="setup-label">API key</span>
        {props.keyHidden ? (
          <ConfiguredButton onClick={props.onRevealKey} />
        ) : (
          <input
            className="text-input"
            type="password"
            value={props.apiKey}
            spellCheck={false}
            autoComplete="off"
            autoFocus={props.keyAutoFocus}
            onChange={(e) => props.onApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && props.onSubmit()}
            placeholder={props.keyPlaceholder}
          />
        )}
        {props.keyHint && <span className="setup-hint">{props.keyHint}</span>}
      </div>
    </div>
  )
}

/**
 * AI provider setup, shown over a darkened chat until the assistant is
 * connected (and reopenable later from the sidebar gear). Three tabs:
 * the models (any OpenAI Responses-API endpoints — the image-capable Medium
 * and Large chat models), optional 2D asset generation (OpenAI gpt-image-1.5)
 * and optional 3D asset generation (Tencent HY 3D).
 */
export function SetupOverlay({ status, onConfigured, onClose }: Props): React.JSX.Element {
  const [tab, setTab] = useState<SetupTab>('agent')
  const [slots, setSlots] = useState<Record<SlotId, SlotState>>(() => ({
    medium: initSlot(status.medium),
    large: initSlot(status.large)
  }))
  const [tencentId, setTencentId] = useState('')
  const [tencentKey, setTencentKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [tencentRevealed, setTencentRevealed] = useState(!status.hy3dConfigured)
  const [openaiKeyRevealed, setOpenaiKeyRevealed] = useState(!status.gptImageConfigured)

  const updateSlot = (id: SlotId, patch: Partial<SlotState>): void =>
    setSlots((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const norm = (endpoint: string): string => endpoint.trim() || OPENROUTER_ENDPOINT

  // A slot can vouch for a key of its own when one was typed now, or when a
  // stored one exists AND the endpoint hasn't changed (a stored key belongs
  // to the endpoint it was entered for). Keyless slots can instead share a
  // vouching slot's key by pointing at the same endpoint — the main process
  // copies it into the slot's own credential on save.
  const hasOwnKey = (id: SlotId): boolean =>
    !!slots[id].apiKey.trim() || (status[id].configured && norm(slots[id].endpoint) === norm(status[id].endpoint))
  const covered = (id: SlotId): boolean =>
    hasOwnKey(id) ||
    MODEL_SLOTS.some((other) => other.id !== id && norm(slots[other.id].endpoint) === norm(slots[id].endpoint) && hasOwnKey(other.id))

  const keyPlaceholder = (id: SlotId): string => {
    if (status[id].configured && norm(slots[id].endpoint) === norm(status[id].endpoint)) {
      return 'Leave blank to keep the stored key'
    }
    if (id !== 'medium' && norm(slots[id].endpoint) === norm(slots.medium.endpoint)) {
      return 'Leave blank to use the Medium model’s API key'
    }
    return id === 'medium' && !status.medium.configured ? 'Your API key' : 'API key for this endpoint'
  }

  // Save applies every tab at once, so a validation error may concern a tab
  // the user isn't looking at — switch to it so the message makes sense.
  const fail = (message: string, where: SetupTab): void => {
    setError(message)
    setTab(where)
  }

  const save = async (): Promise<void> => {
    for (const { id, title } of MODEL_SLOTS) {
      if (!covered(id)) {
        fail(
          `"${title}" has no usable API key — enter one, or point its endpoint at another section's endpoint to share that key.`,
          'agent'
        )
        return
      }
    }
    if (!!tencentId.trim() !== !!tencentKey.trim()) {
      fail('Enter both the Tencent SecretId and SecretKey (or leave both blank).', '3d')
      return
    }
    setBusy(true)
    setError(null)
    const slotRequest = (id: SlotId): ModelSlotRequest => ({
      endpoint: slots[id].endpoint,
      model: slots[id].model,
      apiKey: slots[id].apiKey,
      thinking: slots[id].thinking,
      effort: slots[id].effort
    })
    const result = await window.api.saveSetup({
      medium: slotRequest('medium'),
      large: slotRequest('large'),
      tencentSecretId: tencentId,
      tencentSecretKey: tencentKey,
      openaiApiKey: openaiKey
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const broken = MODEL_SLOTS.find(({ id }) => !result.data[id].configured)
    if (broken) {
      setError(`The "${broken.title}" endpoint still has no usable credential — double-check its API key.`)
    } else {
      onConfigured(result.data)
      onClose?.()
    }
  }

  return (
    <div className="setup-overlay">
      <div className="setup-card">
        {onClose && (
          <button className="icon-btn setup-close" onClick={onClose} title="Close">
            <XIcon size={12} />
          </button>
        )}
        <div className="setup-head">
          <span className="setup-icon">
            <SparkIcon size={18} />
          </span>
          <div>
            <h2 className="setup-title">{status.configured ? 'AI settings' : 'Connect your AI assistant'}</h2>
            <p className="setup-sub">
              GenieEngine's assistant is powered by OpenAI's Codex agent, running on Medium and Large
              chat models you can switch between per message. Both must accept image input — the
              assistant reads the images you attach and play-tests your game with screenshots itself.
            </p>
          </div>
        </div>

        <div className="setup-tabs" role="tablist">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`setup-tab${tab === id ? ' active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'agent' && (
          <>
            {MODEL_SLOTS.map(({ id, title, hint, modelPlaceholder }) => (
              <ModelSection
                key={id}
                title={title}
                hint={hint}
                endpoint={slots[id].endpoint}
                onEndpoint={(v) => updateSlot(id, { endpoint: v })}
                model={slots[id].model}
                onModel={(v) => updateSlot(id, { model: v })}
                modelPlaceholder={modelPlaceholder}
                thinking={slots[id].thinking}
                onThinking={(v) => updateSlot(id, { thinking: v })}
                effort={slots[id].effort}
                onEffort={(v) => updateSlot(id, { effort: v })}
                apiKey={slots[id].apiKey}
                onApiKey={(v) => updateSlot(id, { apiKey: v })}
                keyPlaceholder={keyPlaceholder(id)}
                keyHint={
                  id === 'medium'
                    ? 'Stored locally by GenieEngine and only ever sent to this endpoint — never written into your game, and the assistant itself can’t read it.'
                    : undefined
                }
                keyHidden={status[id].configured && !slots[id].keyRevealed}
                keyAutoFocus={status[id].configured}
                onRevealKey={() => updateSlot(id, { keyRevealed: true })}
                onSubmit={() => void save()}
              />
            ))}
          </>
        )}

        {tab === '2d' && (
          <>
            <span className="setup-hint">
              Add an OpenAI API key to let the assistant generate 2D art — sprites, icons, UI — as
              transparent 1024×1024 PNGs saved into your game's assets folder. Only OpenAI's
              gpt-image-1.5 model is supported right now.
            </span>

            <div className="setup-field">
              <span className="setup-label">OpenAI API key</span>
              {status.gptImageConfigured && !openaiKeyRevealed ? (
                <ConfiguredButton onClick={() => setOpenaiKeyRevealed(true)} />
              ) : (
                <input
                  className="text-input"
                  type="password"
                  value={openaiKey}
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus={status.gptImageConfigured}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void save()}
                  placeholder={status.gptImageConfigured ? 'Leave blank to keep the stored key' : 'sk-…'}
                />
              )}
            </div>
          </>
        )}

        {tab === '3d' && (
          <>
            <span className="setup-hint">
              Add Tencent Cloud credentials to let the assistant generate 3D models saved into your
              game's assets folder. Only Tencent's HY 3D model is supported right now.
            </span>

            {status.hy3dConfigured && !tencentRevealed ? (
              <div className="setup-field">
                <span className="setup-label">Tencent credentials</span>
                <ConfiguredButton onClick={() => setTencentRevealed(true)} />
              </div>
            ) : (
              <>
                <label className="setup-field">
                  <span className="setup-label">Tencent SecretId</span>
                  <input
                    className="text-input"
                    value={tencentId}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoFocus={status.hy3dConfigured}
                    onChange={(e) => setTencentId(e.target.value)}
                    placeholder={status.hy3dConfigured ? 'Leave blank to keep the stored value' : 'AKID…'}
                  />
                </label>

                <label className="setup-field">
                  <span className="setup-label">Tencent SecretKey</span>
                  <input
                    className="text-input"
                    type="password"
                    value={tencentKey}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setTencentKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void save()}
                    placeholder={status.hy3dConfigured ? 'Leave blank to keep the stored value' : 'Your Tencent Cloud SecretKey'}
                  />
                </label>
              </>
            )}
          </>
        )}

        {error && <div className="error-banner small">{error}</div>}

        <button className="btn btn-primary setup-connect" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : status.configured ? 'Save' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
