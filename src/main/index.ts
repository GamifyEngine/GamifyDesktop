import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { loadShellPath } from './services/binaries'
import { migrateLegacySetup } from './services/chat-setup'
import { shutdownChat } from './services/codex'
import { ensureCodexConfig } from './services/codex-config'
import { stopGame } from './services/game'
import { stopModelProxy } from './services/model-proxy'
import { startTestHarness, stopTestHarness } from './services/test-harness'
import { loadSettings } from './state'
import { sendToRenderer, setMainWindow } from './window'

// Keeps the userData (settings) folder stable between dev and packaged runs.
app.setName('GenieEngine')

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e0e13',
    title: 'GenieEngine',
    // Frameless-style titlebar on macOS for a modern, engine-like look.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      // Renderer stays sandboxed (the Electron default): the preload only
      // uses contextBridge/ipcRenderer/webUtils, which sandboxed preloads support.
      preload: join(__dirname, '../preload/index.js')
    }
  })

  setMainWindow(win)
  win.on('ready-to-show', () => win.show())

  // The macOS traffic lights (hiddenInset title bar) disappear in native
  // fullscreen — the renderer needs to know so it can collapse the padding
  // it otherwise reserves for them (see `.mac .titlebar` in global.css).
  win.on('enter-full-screen', () => sendToRenderer('window:fullscreenChange', true))
  win.on('leave-full-screen', () => sendToRenderer('window:fullscreenChange', false))

  // Any external link (e.g. openrouter.ai in error hints) opens in the browser.
  // Web URLs only, matching the will-navigate handler below: openExternal on
  // other schemes (file:, app-registered protocols) can launch local apps.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Plain <a href> clicks (e.g. links in the chat's rendered markdown) don't
  // go through the window-open handler — they navigate this window, which
  // would replace the whole app UI. Block that and hand external URLs to the
  // OS default browser instead. Same-URL navigations (dev-server reloads)
  // stay allowed.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  })

  if (!app.isPackaged) {
    win.webContents.on('console-message', (_event, _level, message) => {
      console.log('[renderer]', message)
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await loadShellPath()
  loadSettings()
  // Before any chat server starts: Codex reads its config at boot, and an
  // upgrade from the OpenCode-based versions brings its model setup along.
  await migrateLegacySetup().catch((err) => console.error('[genieengine] model setup migration failed:', err))
  await ensureCodexConfig()
  startTestHarness()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // Don't leave orphaned godot/codex processes behind.
  stopGame()
  shutdownChat()
  stopModelProxy()
  stopTestHarness()
})

app.on('window-all-closed', () => {
  app.quit()
})
