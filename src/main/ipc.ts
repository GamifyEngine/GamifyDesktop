import { dialog, ipcMain } from 'electron'
import type { ChatAttachment, ChatModelTier, GameInputEvent, GitChange, InitialState, ProjectInfo, Result, SetupRequest, StageRect } from '../shared/types'
import { normalizeGodotPath, resolveCodex, resolveGodot } from './services/binaries'
import { scanEcs } from './services/ecs'
import * as files from './services/files'
import { handleGameInput, openGodotEditor, playGame, setGameLayerVisible, setStageRect, setTestMonitorRect, stopGame } from './services/game'
import * as git from './services/git'
import {
  appendInputHistory,
  clearChatHistory,
  loadChatState,
  saveChatHistory,
  saveChatHistoryPreservingSession
} from './services/chat-history'
import {
  answerQuestion,
  cancelChat,
  getSessionID,
  newChatSession,
  pendingQuestion,
  redoChat,
  rejectQuestion,
  resumeSession,
  sendChatMessage,
  shutdownChat,
  undoChat
} from './services/codex'
import { getSetupStatus, saveSetup } from './services/chat-setup'
import { cancelGamifySignIn, openGamifyAccountPage, signInToGamify, signOutOfGamify } from './services/gamify-account'
import { cancelExport, revealExport, runExport } from './services/export'
import type { ExportPlatform } from '../shared/types'
import { createProject, openProject, projectInfoFor } from './services/projects'
import {
  addRecentProject,
  getAdvancedMode,
  getCurrentProject,
  getRecentProjectPaths,
  requireProject,
  setAdvancedMode,
  setChatSourceSetting,
  setCurrentProject,
  setGodotPath
} from './state'
import { getMainWindow } from './window'

/**
 * Every handler is wrapped in a Result envelope so expected failures (godot
 * missing, git errors, invalid folders…) flow to the UI as messages instead
 * of opaque "Error invoking remote method" exceptions.
 */
function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<Result<unknown>> => {
    try {
      return { ok: true, data: (await fn(...(args as never[]))) ?? null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** Opening/closing a project tears down anything bound to the previous one. */
function activateProject(project: ProjectInfo | null): void {
  stopGame()
  shutdownChat()
  setCurrentProject(project)
  if (project) addRecentProject(project.path)
}

export function registerIpcHandlers(): void {
  // ---- App / project lifecycle -------------------------------------------
  handle('app:getInitialState', async (): Promise<InitialState> => {
    const recents = await Promise.all(getRecentProjectPaths().map(projectInfoFor))
    return {
      project: getCurrentProject(),
      recentProjects: recents,
      godotPath: await resolveGodot(),
      codexPath: await resolveCodex(),
      advancedMode: getAdvancedMode(),
      isFullScreen: getMainWindow()?.isFullScreen() ?? false
    }
  })

  handle('app:setAdvancedMode', (value: boolean) => setAdvancedMode(Boolean(value)))

  handle('dialog:chooseDirectory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('project:create', async (parentDir: string, name: string): Promise<ProjectInfo> => {
    const project = await createProject(parentDir, name)
    activateProject(project)
    return project
  })

  handle('project:open', async (path: string): Promise<ProjectInfo> => {
    const project = await openProject(path)
    activateProject(project)
    return project
  })

  handle('project:openDialog', async (): Promise<ProjectInfo | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Open a Godot project',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const project = await openProject(result.filePaths[0])
    activateProject(project)
    return project
  })

  handle('project:close', () => activateProject(null))

  // ---- Game ----------------------------------------------------------------
  handle('game:play', () => playGame(requireProject().path))
  handle('game:stop', () => stopGame())
  // High-frequency fire-and-forget channels — plain listeners, no Result envelope.
  ipcMain.on('game:stageBounds', (_event, rect: StageRect) => setStageRect(rect))
  ipcMain.on('game:testMonitorBounds', (_event, rect: StageRect) => setTestMonitorRect(rect))
  ipcMain.on('game:input', (_event, input: GameInputEvent) => handleGameInput(input))
  ipcMain.on('game:layerVisible', (_event, visible: boolean) => setGameLayerVisible(Boolean(visible)))
  handle('game:locateGodot', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Locate the Godot application or binary',
      defaultPath: '/Applications',
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = normalizeGodotPath(result.filePaths[0])
    setGodotPath(path)
    const resolved = await resolveGodot()
    if (!resolved) throw new Error(`The selected file is not an executable Godot binary: ${path}`)
    return resolved
  })

  // ---- AI chat ---------------------------------------------------------------
  // The tier is renderer input — anything but 'large' falls back to 'medium'.
  handle('chat:send', (message: string, attachments?: ChatAttachment[], tier?: ChatModelTier, clientMessageId?: string) =>
    sendChatMessage(
      message,
      requireProject().path,
      attachments ?? [],
      tier === 'large' ? 'large' : 'medium',
      typeof clientMessageId === 'string' ? clientMessageId : undefined
    )
  )
  handle('chat:cancel', () => cancelChat())
  // /undo & /redo: rewinds the conversation AND restores the project files.
  handle('chat:undo', () => undoChat(requireProject().path))
  handle('chat:redo', () => redoChat(requireProject().path))
  // /clear: fresh conversation and the saved transcript is forgotten (the
  // ↑/↓ input history intentionally survives — see chat-history.ts).
  handle('chat:new', async () => {
    newChatSession()
    await clearChatHistory(requireProject().path)
  })
  // Chat persistence takes explicit project paths (not requireProject): a
  // debounced save can still fire from the previous project's ChatPanel just
  // after the current project changed, and must land in its own folder.
  handle('chat:loadState', async (projectPath: string) => {
    const state = await loadChatState(projectPath)
    // Continue the saved conversation only when this is (still) the active
    // project — the AI then keeps its context, not just the visible log.
    if (getCurrentProject()?.path === projectPath) resumeSession(state.sessionID)
    return {
      messages: state.messages,
      inputHistory: state.inputHistory,
      // A window reload mid-turn must re-surface the question the assistant
      // is blocked on, or the turn would hang with no buttons anywhere.
      pendingQuestion: await pendingQuestion()
    }
  })
  // A save from a no-longer-active project (debounced saves race project
  // switches) can't vouch for the session id — preserve the file's own rather
  // than stamping null and severing the transcript from its conversation.
  handle('chat:saveHistory', (projectPath: string, messages: unknown[]) =>
    getCurrentProject()?.path === projectPath
      ? saveChatHistory(projectPath, messages, getSessionID())
      : saveChatHistoryPreservingSession(projectPath, messages)
  )
  handle('chat:appendInput', (projectPath: string, entry: string) => appendInputHistory(projectPath, entry))
  handle('chat:answerQuestion', (requestID: string, answers: string[][]) => answerQuestion(requestID, answers))
  handle('chat:rejectQuestion', (requestID: string) => rejectQuestion(requestID))
  handle('chat:setupStatus', () => getSetupStatus())
  handle('chat:saveSetup', async (request: SetupRequest) => {
    await saveSetup(request)
    return getSetupStatus()
  })

  // ---- Gamify account ----------------------------------------------------------
  handle('account:signIn', async () => {
    await signInToGamify()
    // Signing in is choosing the account: the assistant runs on it from now on.
    setChatSourceSetting('gamify')
    return getSetupStatus()
  })
  handle('account:cancelSignIn', () => cancelGamifySignIn())
  handle('account:signOut', async () => {
    await signOutOfGamify()
    return getSetupStatus()
  })
  handle('account:openPage', () => openGamifyAccountPage())

  // ---- Export ----------------------------------------------------------------
  handle('export:run', (name: string, platforms: ExportPlatform[]) =>
    runExport(requireProject().path, name, platforms)
  )
  handle('export:cancel', () => cancelExport())
  handle('export:reveal', (path: string) => revealExport(path))

  // ---- ECS viewer -------------------------------------------------------------
  handle('ecs:scan', () => scanEcs(requireProject().path))

  // ---- Files -----------------------------------------------------------------
  handle('files:list', (dir: string) => files.listDir(dir))
  handle('files:openVSCode', (target?: string) => files.openInVSCode(target ?? requireProject().path))
  handle('files:openGodotEditor', () => openGodotEditor(requireProject().path))

  // ---- Git ---------------------------------------------------------------------
  handle('git:status', () => git.status(requireProject().path))
  handle('git:init', () => git.init(requireProject().path))
  handle('git:stage', (paths: string[]) => git.stage(requireProject().path, paths))
  handle('git:unstage', (paths: string[]) => git.unstage(requireProject().path, paths))
  handle('git:discard', (change: GitChange) => git.discard(requireProject().path, change))
  handle('git:commit', (message: string) => git.commit(requireProject().path, message))
  handle('git:push', () => git.push(requireProject().path))
  handle('git:pull', () => git.pull(requireProject().path))
  handle('git:addRemote', (url: string) => git.addRemote(requireProject().path, url))
  handle('git:log', () => git.log(requireProject().path))
}
