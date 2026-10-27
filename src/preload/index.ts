import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { GenieEngineApi } from '../shared/types'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function subscribe(channel: string, cb: (...args: never[]) => void): () => void {
  const listener = (_event: unknown, ...args: unknown[]): void => {
    ;(cb as (...a: unknown[]) => void)(...args)
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: GenieEngineApi = {
  platform: process.platform,

  getInitialState: () => invoke('app:getInitialState'),
  chooseDirectory: () => invoke('dialog:chooseDirectory'),
  createProject: (parentDir, name) => invoke('project:create', parentDir, name),
  openProject: (path) => invoke('project:open', path),
  openProjectDialog: () => invoke('project:openDialog'),
  closeProject: () => invoke('project:close'),
  setAdvancedMode: (value) => invoke('app:setAdvancedMode', value),
  onFullscreenChange: (cb) => subscribe('window:fullscreenChange', cb),

  playGame: () => invoke('game:play'),
  stopGame: () => invoke('game:stop'),
  locateGodot: () => invoke('game:locateGodot'),
  setGameStageBounds: (rect) => ipcRenderer.send('game:stageBounds', rect),
  setTestMonitorBounds: (rect) => ipcRenderer.send('game:testMonitorBounds', rect),
  sendGameInput: (event) => ipcRenderer.send('game:input', event),
  setGameLayerVisible: (visible) => ipcRenderer.send('game:layerVisible', visible),
  onGameLog: (cb) => subscribe('game:log', cb),
  onGameState: (cb) => subscribe('game:state', cb),
  onGameCursor: (cb) => subscribe('game:cursor', cb),
  onGameTestShot: (cb) => subscribe('game:test-shot', cb),
  onGameFps: (cb) => subscribe('game:fps', cb),

  chatSend: (message, attachments, tier, clientMessageId) =>
    invoke('chat:send', message, attachments, tier, clientMessageId),
  // File objects lost their .path in modern Electron — this is the sanctioned
  // way for the renderer to learn where a dropped/picked file lives on disk
  // (asset uploads travel by path, not by value; see ChatAttachment).
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return '' // synthesized Files have no disk path
    }
  },
  chatCancel: () => invoke('chat:cancel'),
  chatUndo: () => invoke('chat:undo'),
  chatRedo: () => invoke('chat:redo'),
  chatNewSession: () => invoke('chat:new'),
  chatLoadState: (projectPath) => invoke('chat:loadState', projectPath),
  chatSaveHistory: (projectPath, messages) => invoke('chat:saveHistory', projectPath, messages),
  chatAppendInput: (projectPath, entry) => invoke('chat:appendInput', projectPath, entry),
  chatAnswerQuestion: (requestID, answers) => invoke('chat:answerQuestion', requestID, answers),
  chatRejectQuestion: (requestID) => invoke('chat:rejectQuestion', requestID),
  getSetupStatus: () => invoke('chat:setupStatus'),
  saveSetup: (request) => invoke('chat:saveSetup', request),
  onChatPart: (cb) => subscribe('chat:part', cb),
  onChatDone: (cb) => subscribe('chat:done', cb),
  onAssetPreview: (cb) => subscribe('chat:asset-preview', cb),
  onChatFilesChanged: (cb) => subscribe('chat:files-changed', cb),
  onChatQuestion: (cb) => subscribe('chat:question', cb),
  onChatQuestionDone: (cb) => subscribe('chat:question-done', cb),

  exportGame: (name, platforms) => invoke('export:run', name, platforms),
  cancelExport: () => invoke('export:cancel'),
  revealExport: (path) => invoke('export:reveal', path),
  onExportProgress: (cb) => subscribe('export:progress', cb),

  scanEcs: () => invoke('ecs:scan'),

  listDir: (path) => invoke('files:list', path),
  openInVSCode: (target) => invoke('files:openVSCode', target),
  openInGodotEditor: () => invoke('files:openGodotEditor'),

  gitStatus: () => invoke('git:status'),
  gitInit: () => invoke('git:init'),
  gitStage: (paths) => invoke('git:stage', paths),
  gitUnstage: (paths) => invoke('git:unstage', paths),
  gitDiscard: (change) => invoke('git:discard', change),
  gitCommit: (message) => invoke('git:commit', message),
  gitPush: () => invoke('git:push'),
  gitPull: () => invoke('git:pull'),
  gitAddRemote: (url) => invoke('git:addRemote', url),
  gitLog: () => invoke('git:log')
}

contextBridge.exposeInMainWorld('api', api)
