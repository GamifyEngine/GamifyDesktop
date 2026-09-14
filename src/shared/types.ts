/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. This file is the single source of truth for the IPC surface.
 */

/** Uniform envelope returned by every IPC call so the renderer can render errors inline. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export interface ProjectInfo {
  path: string
  name: string
}

export interface InitialState {
  project: ProjectInfo | null
  recentProjects: ProjectInfo[]
  /** Resolved path of the Godot binary, or null when it could not be found. */
  godotPath: string | null
  /** Resolved path of the OpenCode CLI, or null when it could not be found. */
  opencodePath: string | null
  /** Whether the ECS viewer, files/git sidebars and console output are shown. */
  advancedMode: boolean
  /** Whether the window is currently in native (macOS green-button) fullscreen. */
  isFullScreen: boolean
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface GitRemote {
  name: string
  url: string
}

export interface GitChange {
  path: string
  /** Single-letter status code shown in the UI (M, A, D, R, ?, …). */
  status: string
  staged: boolean
  untracked: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  staged: GitChange[]
  unstaged: GitChange[]
  remotes: GitRemote[]
}

export interface GitCommit {
  hash: string
  subject: string
}

export interface ChatDonePayload {
  ok: boolean
  cancelled?: boolean
  error?: string
}

/**
 * A file the user attached to a chat message. Two flavors:
 *
 * - Inline (`dataUrl` set): images and small text files — ride the chat
 *   message itself as data-URL parts, never written into the game project.
 * - Asset upload (`path` set): .zip archives, whole folders, and binary asset
 *   files (3D models, audio, fonts) — too big/opaque to inline, so only the
 *   absolute disk path crosses to the main process, which copies the payload
 *   into the project's .genieengine/attachments/ when the message is sent and
 *   points the assistant at it there.
 */
export interface ChatAttachment {
  name: string
  mime: string
  dataUrl?: string
  path?: string
  /** True when `path` points at a folder. */
  dir?: boolean
}

/**
 * Persisted chat state for a project, loaded when it opens. `messages` is the
 * renderer's own transcript JSON — opaque to the main process; the renderer
 * validates the shape on restore.
 */
export interface SavedChatState {
  messages: unknown[]
  /** Everything the user ever sent, oldest first — for ↑/↓ recall. */
  inputHistory: string[]
  /** A question the assistant is still waiting on (survives window reloads). */
  pendingQuestion: ChatQuestionRequest | null
}

/** One choice offered by the assistant's interactive "question" tool. */
export interface ChatQuestionOption {
  label: string
  description: string
}

/** One question from the assistant's "question" tool (mirrors OpenCode's schema). */
export interface ChatQuestion {
  question: string
  /** Short chip/tag label, e.g. "Art style". */
  header: string
  options: ChatQuestionOption[]
  /** Allow selecting several options. */
  multiple?: boolean
  /** Allow a free-text answer. */
  custom?: boolean
}

/**
 * A pending "question" tool request. The turn blocks until every question is
 * answered (chatAnswerQuestion) or the request is dismissed
 * (chatRejectQuestion) — ignoring it would leave the tool spinning forever.
 */
export interface ChatQuestionRequest {
  id: string
  questions: ChatQuestion[]
}

/**
 * Which chat model a message runs on: the everyday Medium model or the
 * heavyweight Large model for tough tasks (more capable, may cost more).
 * Both must accept image input — the same model reads attached images and
 * game screenshots, and runs the game-tester subagent.
 */
export type ChatModelTier = 'medium' | 'large'

/**
 * Whether the model should think before answering. Sent to the model as the
 * standard OpenAI-format `thinking: {"type": "enabled"|"disabled"}` request
 * field (see https://api-docs.deepseek.com/guides/thinking_mode/);
 * 'default' sends nothing and leaves the model on its own default.
 */
export type ThinkingMode = 'default' | 'enabled' | 'disabled'

/**
 * How hard the model should think, sent as the standard OpenAI-format
 * `reasoning_effort` request field; 'default' sends nothing.
 */
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** One model slot's stored connection settings, as shown in the setup panel. */
export interface ModelSlotStatus {
  /** Base URL of the OpenAI-compatible API this model is served from. */
  endpoint: string
  model: string
  /** True once this model's endpoint has a usable credential. */
  configured: boolean
  thinking: ThinkingMode
  effort: ReasoningEffort
}

/** State of the AI provider setup (API keys / endpoints / models). */
export interface SetupStatus {
  /** True once both chat models are usable (the chat dropdown can switch between them any time). */
  configured: boolean
  /** Everyday chat/coding model. */
  medium: ModelSlotStatus
  /** Heavyweight chat model for tough tasks. */
  large: ModelSlotStatus
  /** True when Tencent HY 3D credentials are stored (enables 3D asset generation). */
  hy3dConfigured: boolean
  /** True when an OpenAI key is stored (enables 2D image asset generation). */
  gptImageConfigured: boolean
}

/** One model slot's settings as submitted by the setup panel. */
export interface ModelSlotRequest {
  endpoint: string
  model: string
  /** Blank = keep the stored key (or share the Medium model's key on a matching endpoint). */
  apiKey: string
  thinking: ThinkingMode
  effort: ReasoningEffort
}

/**
 * Everything the AI settings panel saves in one go. Blank credential fields
 * mean "leave the stored key unchanged"; blank endpoints/models fall back to
 * the defaults.
 */
export interface SetupRequest {
  medium: ModelSlotRequest
  large: ModelSlotRequest
  /** Optional asset-generation credentials (blank = unchanged). */
  tencentSecretId?: string
  tencentSecretKey?: string
  openaiApiKey?: string
}

/** A generated asset preview pushed into the chat so the user can react to it. */
export interface AssetPreview {
  /** data: URL of the preview image (PNG for 2D art, GIF turntable for 3D). */
  dataUrl: string
  /** Asset name the AI chose, e.g. "rocket". */
  label: string
  /** Project-relative folder the files were written to. */
  path: string
  kind: '2d' | '3d'
}

/** Live status of a tool invocation the AI is running. */
export type ChatToolStatus = 'pending' | 'running' | 'completed' | 'error'

/**
 * Incremental update for one part of a streaming assistant message.
 * Text/reasoning parts carry the full accumulated text (idempotent upsert);
 * tool parts carry their latest state.
 */
export interface ChatPartUpdate {
  messageID: string
  partID: string
  kind: 'text' | 'reasoning' | 'tool'
  text?: string
  tool?: {
    name: string
    status: ChatToolStatus
    title?: string
    /** Failure reason when status is 'error' — tooltip on the chip. */
    error?: string
    /** Set when a subagent (game-tester) ran this tool — the chip is labelled with it. */
    agent?: string
  }
}

/**
 * How a running game is displayed.
 *  - 'embedded': rendered inside the stage as a native layer (macOS
 *    --embedded); the renderer's transparent overlay captures and forwards
 *    input.
 *  - 'embedded-window': the game's own borderless window is kept glued over
 *    the stage (Windows --wid embedding); the OS routes input to it directly,
 *    so no overlay is mounted.
 *  - 'external': free-floating OS window — the fallback wherever embedding is
 *    unavailable (Linux, failed addon builds, embedding errors).
 */
export type GamePresentation = 'embedded' | 'embedded-window' | 'external'

/** How the game is currently being presented. */
export interface GameState {
  status: 'stopped' | 'starting' | 'running'
  /** 'native' = embedded in the game view; 'test' = AI running it off-screen. */
  mode?: 'native' | 'test'
  /** Where the running game lives. Unset for test runs on macOS (the game is
   *  fully off-screen — nothing is presented). */
  view?: GamePresentation
  /** Test runs: true when the off-screen game can be mirrored live into the
   *  test monitor (layerhost addon available — macOS). */
  liveView?: boolean
  /** Test runs: the size the off-screen game renders at, so the live monitor
   *  box can reserve a matching shape. */
  testGameSize?: { width: number; height: number }
}

/** Viewport-relative rect of the game stage area, reported by the renderer. */
export interface StageRect {
  x: number
  y: number
  width: number
  height: number
}

/** Aspect-ratio presets for the game preview area (UI-side letterboxing). */
export type AspectMode = 'any' | 'desktop' | 'mobile-portrait' | 'mobile-landscape'

/** Platforms Godot can export a project to. */
export type ExportPlatform = 'windows' | 'macos' | 'linux' | 'web' | 'android' | 'ios'

/** Progress updates streamed while an export runs. */
export type ExportProgress =
  | { phase: 'templates'; message: string; percent: number }
  | { phase: 'platform'; platform: ExportPlatform; status: 'exporting' | 'success' | 'error'; message?: string }
  | { phase: 'done'; message?: string }

/**
 * A code file with a parsed `#=== genieengine ===` header block (the format the
 * injected agent instructions mandate for every file the AI writes — see
 * resources/agent-instructions.md). Backs the ECS viewer in the center pane.
 */
export interface EcsNode {
  /** Project-relative path, e.g. "components/c_health.gd". */
  path: string
  /** File basename without extension — the node id edges refer to, e.g. "c_health". */
  id: string
  /** entity | component | system | autoload | ui | util | shader | other */
  kind: string
  name: string
  summary: string
  /** Component ids (c_*) this file composes (entities) or processes (systems). */
  uses: string[]
  /** Free-form header lines beyond the standard keys, shown verbatim in the detail card. */
  extra: string[]
}

/** Modifier keys held during an input event. */
export interface GameInputModifiers {
  shift: boolean
  ctrl: boolean
  alt: boolean
  meta: boolean
}

/**
 * Input captured by the renderer over the embedded native game view,
 * forwarded to the game process. Coordinates are CSS px relative to the view.
 */
export type GameInputEvent =
  | (GameInputModifiers & {
      type: 'key'
      key: string
      code: string
      pressed: boolean
      echo: boolean
      location: number
    })
  | (GameInputModifiers & {
      type: 'mousebutton'
      button: number // DOM button index
      buttons: number // DOM buttons bitmask
      pressed: boolean
      doubleClick: boolean
      x: number
      y: number
    })
  | (GameInputModifiers & {
      type: 'mousemotion'
      x: number
      y: number
      relX: number
      relY: number
      buttons: number
    })
  | (GameInputModifiers & { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number })
  | { type: 'enter' }
  | { type: 'leave' }
  | { type: 'focus' }
  | { type: 'blur' }

/** The API the preload script exposes on `window.api`. */
export interface GenieEngineApi {
  platform: string

  // App / project lifecycle
  getInitialState(): Promise<Result<InitialState>>
  chooseDirectory(): Promise<Result<string | null>>
  createProject(parentDir: string, name: string): Promise<Result<ProjectInfo>>
  openProject(path: string): Promise<Result<ProjectInfo>>
  openProjectDialog(): Promise<Result<ProjectInfo | null>>
  closeProject(): Promise<Result<null>>
  /** Persists whether advanced panels (ECS viewer, files, git, console) are shown. */
  setAdvancedMode(value: boolean): Promise<Result<null>>
  /** Fires when the window enters/exits native (macOS green-button) fullscreen. */
  onFullscreenChange(cb: (isFullScreen: boolean) => void): () => void

  // Game (Godot)
  playGame(): Promise<Result<null>>
  stopGame(): Promise<Result<null>>
  locateGodot(): Promise<Result<string | null>>
  /** Fire-and-forget: keeps the main process aware of where the stage is. */
  setGameStageBounds(rect: StageRect): void
  /** Fire-and-forget: where the AI test run's live monitor box sits, so the
   *  off-screen game's layer can be composited (scaled down) into it. */
  setTestMonitorBounds(rect: StageRect): void
  /** Fire-and-forget: input captured over the embedded native game view. */
  sendGameInput(event: GameInputEvent): void
  /**
   * Fire-and-forget: hides/shows the embedded native game layer. The layer is
   * composited by the OS above the web contents, so CSS cannot cover it —
   * the renderer must hide it while another center tab is active.
   */
  setGameLayerVisible(visible: boolean): void
  onGameLog(cb: (line: string) => void): () => void
  onGameState(cb: (state: GameState) => void): () => void
  /** Godot CursorShape the game requested over its view (native mode). */
  onGameCursor(cb: (shape: number) => void): () => void
  /** PNG data URL each time the AI captures a screenshot during a test run. */
  onGameTestShot(cb: (dataUrl: string) => void): () => void
  /** Measured game frame rate, ~1 update/second while a game runs. */
  onGameFps(cb: (fps: number) => void): () => void

  // AI chat (OpenCode)
  /** `tier` picks which chat model answers; the conversation continues either way. */
  chatSend(message: string, attachments?: ChatAttachment[], tier?: ChatModelTier): Promise<Result<null>>
  /**
   * Absolute disk path of a picked/dropped File (Electron webUtils) — '' when
   * it has none (e.g. a File synthesized in the page). Synchronous.
   */
  pathForFile(file: File): string
  chatCancel(): Promise<Result<null>>
  /**
   * /undo: revert the conversation one user turn (OpenCode restores the files
   * that turn touched). `revertedTo` is the OpenCode id of the undone user
   * message — the renderer drops its transcript from the matching turn on.
   */
  chatUndo(): Promise<Result<{ revertedTo: string }>>
  /** /redo: step the revert point forward again (files and conversation). */
  chatRedo(): Promise<Result<null>>
  /** /clear: fresh conversation AND deletes the project's saved transcript. */
  chatNewSession(): Promise<Result<null>>
  /** Saved transcript + input history for a project; also resumes its AI session. */
  chatLoadState(projectPath: string): Promise<Result<SavedChatState>>
  /** Persist the transcript (called debounced whenever the chat settles). */
  chatSaveHistory(projectPath: string, messages: unknown[]): Promise<Result<null>>
  /** Record a sent message for ↑/↓ recall (kept even across /clear). */
  chatAppendInput(projectPath: string, entry: string): Promise<Result<null>>
  /** Answer a pending question — one array of selected labels per question, in order. */
  chatAnswerQuestion(requestID: string, answers: string[][]): Promise<Result<null>>
  /** Dismiss a pending question (the assistant is told and continues without answers). */
  chatRejectQuestion(requestID: string): Promise<Result<null>>
  getSetupStatus(): Promise<Result<SetupStatus>>
  /** Credential fields left blank = leave that provider's setup unchanged. */
  saveSetup(request: SetupRequest): Promise<Result<SetupStatus>>
  onChatPart(cb: (part: ChatPartUpdate) => void): () => void
  onChatDone(cb: (payload: ChatDonePayload) => void): () => void
  /** A generated 2D/3D asset preview to render in the chat (user can give feedback). */
  onAssetPreview(cb: (preview: AssetPreview) => void): () => void
  /** Fired (debounced) when the AI edits project files during a response. */
  onChatFilesChanged(cb: () => void): () => void
  /** The assistant asked interactive question(s) and is blocked on the reply. */
  onChatQuestion(cb: (request: ChatQuestionRequest) => void): () => void
  /** A pending question was resolved elsewhere (answered/rejected/expired). */
  onChatQuestionDone(cb: (requestID: string) => void): () => void

  // Export
  exportGame(name: string, platforms: ExportPlatform[]): Promise<Result<null>>
  cancelExport(): Promise<Result<null>>
  revealExport(path: string): Promise<Result<null>>
  onExportProgress(cb: (update: ExportProgress) => void): () => void

  // ECS viewer
  scanEcs(): Promise<Result<EcsNode[]>>

  // Files
  listDir(path: string): Promise<Result<FileEntry[]>>
  openInVSCode(target?: string): Promise<Result<null>>
  openInGodotEditor(): Promise<Result<null>>

  // Git
  gitStatus(): Promise<Result<GitStatus>>
  gitInit(): Promise<Result<null>>
  gitStage(paths: string[]): Promise<Result<null>>
  gitUnstage(paths: string[]): Promise<Result<null>>
  gitDiscard(change: GitChange): Promise<Result<null>>
  gitCommit(message: string): Promise<Result<string>>
  gitPush(): Promise<Result<string>>
  gitPull(): Promise<Result<string>>
  gitAddRemote(url: string): Promise<Result<null>>
  gitLog(): Promise<Result<GitCommit[]>>
}
