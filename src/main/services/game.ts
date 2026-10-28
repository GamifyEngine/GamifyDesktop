import { app, screen, type BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { GameInputEvent, GameState, StageRect } from '../../shared/types'
import { getMainWindow, sendToRenderer } from '../window'
import { resolveGodot } from './binaries'
import { EmbedSession, NOTIFICATION, WIN_EVENT } from './godot-embed'
import {
  domButtonsToGodotMask,
  domButtonToGodot,
  encodeKeyEvent,
  encodeMouseButtonEvent,
  encodeMouseMotionEvent,
  keyEventToAgentPayload,
  mouseButtonToAgentPayload,
  mouseMotionToAgentPayload,
  type KeyEventInput,
  type MouseButtonInput,
  type MouseMotionInput
} from './godot-input-codec'
import { addPerfFrames, appendPerfLog, drainPerfWindow, formatPerfStats, resetPerfWindow, type PerfStats } from './perf-monitor'
import { cleanupTestAgent, injectTestAgent } from './test-agent'
import { windowHandleArg, winhost, type WinHost } from './winhost'

/**
 * Runs the user's game with the full desktop engine, rendered *inside* the
 * GamifyDesktop window. Uses Godot 4.6+'s embedded display server (the same
 * mechanism the Godot editor uses for its in-editor game view on macOS): the
 * game process renders into a cross-process CoreAnimation context, which we
 * composite via the layerhost native addon; display state and input travel
 * over Godot's debugger protocol. Works in fullscreen — it's just a layer in
 * our window. AI test runs use the same pipeline without attaching the layer.
 *
 * Godot's embedded display server is macOS-ONLY. On Windows the game is
 * embedded the way the Godot editor does it there: launched with `--wid` so
 * its borderless window is OWNED by ours, then kept glued over the stage by
 * winhost.ts (SetWindowPos via FFI) — input reaches it directly from the OS.
 * Anywhere else (Linux, embedding unavailable) the game falls back to running
 * in its own free-floating OS window. The debugger channel and the injected
 * test agent are platform-independent, so AI test runs (screenshots, eval,
 * scene tree, perf/FPS) work in every presentation; off-macOS, input
 * injection switches from the embed:event channel to in-process injection
 * via the agent (ogtest:input).
 */

let state: GameState = { status: 'stopped' }
let nativeProcess: ChildProcess | null = null

// Native embedded-session state
let embedSession: EmbedSession | null = null
// Whether the current run uses the embedded display server (macOS) or the
// windowed fallback — decides how input reaches the game and how it's closed.
let embeddedRun = false
let layerAttached = false
// Renderer's last requested layer visibility — remembered so a layer that
// attaches while something covers the stage (modal, ECS tab) starts hidden.
let layerVisibleWanted = true
let stageRect: StageRect | null = null

// Live monitor for AI test runs: the off-screen game renders into a CAContext
// either way, so the layer host can mirror it — scaled down — into the small
// monitor box the test card shows. The renderer reports that box's rect; the
// context id waits here until it does (the card only renders once the state
// flips to running, i.e. after the id arrived).
let testMonitorRect: StageRect | null = null
let testContextId: number | null = null
let testGameSize: { width: number; height: number } | null = null

// The project that currently has the agent (test-agent.ts) injected — set for
// every embedded run (play and test), cleaned up on stop. Also where perf.log goes.
let injectedProjectPath: string | null = null

// AI test-run state
let testCommandCounter = 0
const pendingTestReplies = new Map<
  number,
  { resolve: (r: { ok: boolean; text: string }) => void; timer: ReturnType<typeof setTimeout> }
>()

/**
 * Budget for one AI test run. Without a cap, open-ended test briefs ran
 * 50-70 agent-loop steps (12+ minutes): the model kept probing instead of
 * concluding, every step re-sent the whole screenshot-laden conversation,
 * and the provider started failing (413/500) — the user saw a frozen chat
 * and cancelled. Healthy focused runs finish in well under 20 tool calls,
 * so the cap only trips runaway sessions. Enforced in the harness
 * (test-harness.ts) because a prompt-only budget is routinely ignored.
 * Starting a new run_game_test resets the budget — deliberate: a fresh run
 * restarts the game, so it can't be farmed to extend one endless session.
 */
const TEST_BUDGET = { calls: 40, ms: 8 * 60_000, warnCalls: 30, warnMs: 6 * 60_000 }
let testToolCalls = 0
let testRunStart = 0

/**
 * Count one game tool call against the current test run's budget and report
 * where it stands. `notice` (when set) must reach the model: it is either the
 * wrap-up warning appended to a successful result or the exhausted message
 * that replaces the tool result entirely.
 */
export function consumeTestBudget(): { exhausted: boolean; notice?: string } {
  if (state.mode !== 'test' || state.status !== 'running') return { exhausted: false }
  testToolCalls++
  const elapsedMs = Date.now() - testRunStart
  const minutes = Math.round(elapsedMs / 60_000)
  if (testToolCalls > TEST_BUDGET.calls || elapsedMs > TEST_BUDGET.ms) {
    return {
      exhausted: true,
      notice:
        `Test budget exhausted (${TEST_BUDGET.calls} game tool calls / ${TEST_BUDGET.ms / 60_000} minutes per run) — ` +
        'stop probing now. Call stop_game_test, then write your report from the evidence you already have. ' +
        'game_logs still works if you need the final console output.'
    }
  }
  if (testToolCalls > TEST_BUDGET.warnCalls || elapsedMs > TEST_BUDGET.warnMs) {
    return {
      exhausted: false,
      notice:
        `[test budget: ${testToolCalls}/${TEST_BUDGET.calls} tool calls, ~${minutes}/${TEST_BUDGET.ms / 60_000} minutes] ` +
        'Wrap up: verify anything essential with the fewest remaining probes, then stop_game_test and report.'
    }
  }
  return { exhausted: false }
}

function setState(next: GameState): void {
  state = next
  sendToRenderer('game:state', state)
}

export function getGameState(): GameState {
  return state
}

// Recent console lines, kept so the AI test harness can read game output.
const logBuffer: string[] = []
const LOG_BUFFER_MAX = 300

export function getGameLogs(): string[] {
  return [...logBuffer]
}

// Godot output can be ANSI-colored; the console renders plain text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g

function emitLog(line: string): void {
  const clean = line.replace(ANSI_RE, '')
  if (clean.trim().length > 0) {
    logBuffer.push(clean)
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX)
    sendToRenderer('game:log', clean)
  }
}

function pipeLines(stream: NodeJS.ReadableStream | null): void {
  if (!stream) return
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(emitLog)
  })
  stream.on('end', () => emitLog(buffer))
}

/**
 * Record a completed 60s frame-rate window: into the game console/log buffer
 * (so the AI's game_logs tool sees it) and the project's .gamifydesktop/perf.log
 * (persistent history for diagnosing performance across runs).
 */
function logPerfStats(stats: PerfStats): void {
  emitLog(`[gamifydesktop] fps ${formatPerfStats(stats)} — history in .gamifydesktop/perf.log`)
  if (injectedProjectPath) {
    void appendPerfLog(injectedProjectPath, state.mode ?? 'native', stats)
  }
}

/** Frame-delta batch (~1/s) from the injected agent — see perf-monitor.ts. */
function handlePerfFrames(deltas: number[]): void {
  const { fps, completed } = addPerfFrames(deltas)
  if (fps !== null) sendToRenderer('game:fps', fps)
  if (completed) logPerfStats(completed)
}

function godotMissingError(): Error {
  return new Error(
    'The bundled Godot engine is missing. Reinstall GamifyDesktop (or run `npm run setup` in development), or locate a Godot binary manually.'
  )
}

// ---------------------------------------------------------------------------
// layerhost native addon (macOS)
// ---------------------------------------------------------------------------

interface LayerHostAddon {
  attach(handle: Buffer, contextId: number, x: number, y: number, w: number, h: number): boolean
  setFrame(x: number, y: number, w: number, h: number): void
  /** Scale the hosted game tree (1 = native size; <1 shrinks into the frame). */
  setScale(scale: number): void
  setVisible(visible: boolean): void
  detach(): void
}

let layerHostAddon: LayerHostAddon | null | undefined

function layerhost(): LayerHostAddon | null {
  if (layerHostAddon !== undefined) return layerHostAddon
  if (process.platform !== 'darwin') {
    layerHostAddon = null
    return null
  }
  const path = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'native', 'layerhost', 'build', 'Release', 'layerhost.node')
    : join(app.getAppPath(), 'native', 'layerhost', 'build', 'Release', 'layerhost.node')
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    layerHostAddon = require(path) as LayerHostAddon
  } catch (err) {
    console.error('[gamifydesktop] failed to load layerhost addon:', err)
    layerHostAddon = null
  }
  return layerHostAddon
}

// ---------------------------------------------------------------------------
// Windows owned-window embedding (winhost.ts)
// ---------------------------------------------------------------------------
//
// Windows equivalent of the layer host, porting the Godot editor's in-editor
// game view (display_server_windows.cpp embed_process, Godot 4.7): the game
// is launched with `--wid <our HWND>`, which makes the engine create its
// window borderless and OWNED by ours — owned windows always float above
// their owner — and winhost keeps that window glued to the stage rect with
// SetWindowPos. The OS routes input to the game window directly, so unlike
// macOS no input forwarding happens.

// Owned-window embed session state (play mode only; test runs stay external).
let winAttached = false
let winAttachPoll: ReturnType<typeof setInterval> | null = null
let trackedWin: BrowserWindow | null = null

/**
 * Stage rect (CSS px, relative to the window's content area) → physical
 * screen pixels, which is what SetWindowPos and Godot's --position expect.
 * dipToScreenRect handles per-monitor DPI (Windows-only API; all callers are
 * win32 paths).
 */
function stageScreenRect(win: BrowserWindow, rect: StageRect): Electron.Rectangle {
  const content = win.getContentBounds()
  return screen.dipToScreenRect(win, {
    x: Math.round(content.x + rect.x),
    y: Math.round(content.y + rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  })
}

function updateWinEmbedFrame(): void {
  const addon = winhost()
  const win = trackedWin ?? getMainWindow()
  if (!winAttached || !addon || !win || !stageRect) return
  const r = stageScreenRect(win, stageRect)
  addon.setFrame(r.x, r.y, r.width, r.height)
}

// The embedded window sits at an absolute screen position, so dragging or
// resizing the GamifyDesktop window must re-glue it (stage-rect reports from the
// renderer only cover layout changes INSIDE the window).
const onHostWindowMoved = (): void => updateWinEmbedFrame()

function trackHostWindow(win: BrowserWindow): void {
  trackedWin = win
  win.on('move', onHostWindowMoved)
  win.on('resize', onHostWindowMoved)
}

function untrackHostWindow(): void {
  trackedWin?.removeListener('move', onHostWindowMoved)
  trackedWin?.removeListener('resize', onHostWindowMoved)
  trackedWin = null
}

function stopWinAttachPoll(): void {
  if (winAttachPoll) {
    clearInterval(winAttachPoll)
    winAttachPoll = null
  }
}

/**
 * Poll for the game's owned window (created shortly after launch thanks to
 * --wid) and glue it to the stage. Mirrors the Godot editor's EmbeddedProcess
 * retry timer: tick until found, with the same generous 45s timeout — first
 * boots of heavy projects can take a long time to open a window. Falls back
 * to free-floating play if embedding never succeeds.
 */
function beginWinEmbedAttach(session: EmbedSession, win: BrowserWindow, addon: WinHost, pid: number): void {
  const deadline = Date.now() + 45000
  const giveUp = (why: string): void => {
    stopWinAttachPoll()
    emitLog(`[gamifydesktop] window embedding unavailable (${why}) — the game plays in its own window`)
    setState({ status: 'running', mode: 'native', view: 'external' })
  }
  const tick = (): void => {
    if (embedSession !== session) {
      // The run was stopped (or replaced) while we were polling.
      stopWinAttachPoll()
      return
    }
    const rect = stageRect ?? { x: 0, y: 0, width: 640, height: 360 }
    const sr = stageScreenRect(win, rect)
    let attached = false
    try {
      attached = addon.attach(win.getNativeWindowHandle(), pid, sr.x, sr.y, sr.width, sr.height, layerVisibleWanted)
    } catch (err) {
      giveUp(err instanceof Error ? err.message : String(err))
      return
    }
    if (attached) {
      stopWinAttachPoll()
      winAttached = true
      trackHostWindow(win)
      emitLog('[gamifydesktop] game embedded over the GamifyDesktop window (native, full performance)')
      setState({ status: 'running', mode: 'native', view: 'embedded-window' })
    } else if (Date.now() > deadline) {
      giveUp('game window not found')
    }
  }
  stopWinAttachPoll()
  winAttachPoll = setInterval(tick, 250)
  tick()
}

// ---------------------------------------------------------------------------
// Native embedded mode
// ---------------------------------------------------------------------------

/** The game's window size message is in *pixels* (the DS divides by scale). */
function sendStageSizeToGame(session: EmbedSession, rect: StageRect): void {
  const win = getMainWindow()
  const scale = win ? currentDisplayState(win).scale : 2
  session.sendWindowSize(rect.width * scale, rect.height * scale)
}

/** Renderer reports where the stage sits inside the window (CSS px = points). */
export function setStageRect(rect: StageRect): void {
  stageRect = rect
  // Test mode: the layer mirrors the game into the monitor box, not the
  // stage, and the off-screen game keeps its launch size (a mid-test resize
  // would disrupt the AI's run).
  if (layerAttached && embedSession && state.mode !== 'test') {
    layerhost()?.setFrame(rect.x, rect.y, rect.width, rect.height)
    sendStageSizeToGame(embedSession, rect)
  }
  if (winAttached) updateWinEmbedFrame()
}

/** Renderer reports where the test card's live monitor box sits. */
export function setTestMonitorRect(rect: StageRect): void {
  testMonitorRect = rect
  updateTestMonitorLayer()
}

/**
 * Attach or reposition the live-monitor layer for an AI test run: the full
 * game tree, letterbox-fitted into the reported box by scaling the layer, so
 * the user can watch the AI play. Purely visual — the box's DOM (hitTest nil)
 * takes no input, and the game's render size is untouched.
 */
function updateTestMonitorLayer(): void {
  const addon = layerhost()
  const win = getMainWindow()
  if (!addon || !win || state.mode !== 'test' || testContextId === null || !testMonitorRect || !testGameSize) return
  if (testMonitorRect.width < 8 || testMonitorRect.height < 8) {
    // The renderer reports a 0-rect when the layout has no room for the
    // monitor — park the attached layer off-screen rather than leaving it at
    // a stale position over other UI (DOM can't cover a native layer).
    if (layerAttached) addon.setFrame(-100000, -100000, 1, 1)
    return
  }
  const scale = Math.min(testMonitorRect.width / testGameSize.width, testMonitorRect.height / testGameSize.height)
  const width = testGameSize.width * scale
  const height = testGameSize.height * scale
  const x = testMonitorRect.x + (testMonitorRect.width - width) / 2
  const y = testMonitorRect.y + (testMonitorRect.height - height) / 2
  try {
    if (!layerAttached) {
      addon.attach(win.getNativeWindowHandle(), testContextId, x, y, width, height)
      layerAttached = true
      if (!layerVisibleWanted) addon.setVisible(false)
    } else {
      addon.setFrame(x, y, width, height)
    }
    addon.setScale(scale)
  } catch (err) {
    // The run works without the live view — don't let a compositing failure
    // take down the test session.
    emitLog(`[gamifydesktop] live test monitor unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Hide/show the embedded game layer. The OS composites it above the web
 * contents, so the renderer can't cover it with DOM — it asks us to hide it
 * while another center tab (e.g. the ECS viewer) or a modal overlay
 * (settings, export) occupies the stage.
 */
export function setGameLayerVisible(visible: boolean): void {
  layerVisibleWanted = visible
  if (layerAttached) layerhost()?.setVisible(visible)
  if (winAttached) winhost()?.setVisible(visible)
}

function currentDisplayState(win: BrowserWindow): { scale: number; dpi: number; displayId: number } {
  const display = screen.getDisplayMatching(win.getBounds())
  return {
    scale: display.scaleFactor || 1,
    dpi: 96 * (display.scaleFactor || 1),
    // On macOS Electron's display id is the CGDirectDisplayID Godot expects.
    displayId: display.id
  }
}

/**
 * Send one Godot-mapped input event over whichever channel the run supports:
 * embedded runs use the byte-encoded embed:event channel (consumed by the
 * macOS embedded display server); windowed runs inject in-process via the
 * test agent (ogtest:input), since embed:event has no receiver there.
 * Agent injections are fire-and-forget (command id 0 is never awaited),
 * matching embed:event's no-acknowledgement semantics.
 */
function dispatchKeyEvent(e: KeyEventInput): void {
  if (embeddedRun) embedSession?.sendInputEvent(encodeKeyEvent(e))
  else embedSession?.sendTestCommand('input', 0, [JSON.stringify(keyEventToAgentPayload(e))])
}

function dispatchMouseButtonEvent(e: MouseButtonInput): void {
  if (embeddedRun) embedSession?.sendInputEvent(encodeMouseButtonEvent(e))
  else embedSession?.sendTestCommand('input', 0, [JSON.stringify(mouseButtonToAgentPayload(e))])
}

function dispatchMouseMotionEvent(e: MouseMotionInput): void {
  if (embeddedRun) embedSession?.sendInputEvent(encodeMouseMotionEvent(e))
  else embedSession?.sendTestCommand('input', 0, [JSON.stringify(mouseMotionToAgentPayload(e))])
}

/** Input events captured by the renderer over the game view. */
export function handleGameInput(event: GameInputEvent): void {
  if (!embedSession) return
  switch (event.type) {
    case 'key':
      dispatchKeyEvent(event)
      break
    case 'mousebutton':
      dispatchMouseButtonEvent({
        ...event,
        button: domButtonToGodot(event.button),
        mask: domButtonsToGodotMask(event.buttons)
      })
      break
    case 'mousemotion':
      dispatchMouseMotionEvent({ ...event, mask: domButtonsToGodotMask(event.buttons) })
      break
    case 'wheel':
      handleWheel(event)
      break
    // Window-state events below only exist on the embedded display server; a
    // windowed game gets enter/leave/focus from the OS directly.
    case 'enter':
      if (embeddedRun) embedSession.sendWinEvent(WIN_EVENT.MOUSE_ENTER)
      break
    case 'leave':
      if (embeddedRun) embedSession.sendWinEvent(WIN_EVENT.MOUSE_EXIT)
      break
    case 'focus':
      if (embeddedRun) {
        embedSession.sendNotification(NOTIFICATION.APPLICATION_FOCUS_IN)
        embedSession.sendWinEvent(WIN_EVENT.FOCUS_IN)
      }
      break
    case 'blur':
      if (embeddedRun) {
        embedSession.sendWinEvent(WIN_EVENT.FOCUS_OUT)
        embedSession.sendNotification(NOTIFICATION.APPLICATION_FOCUS_OUT)
      }
      break
  }
}

// Wheel deltas accumulate into discrete Godot wheel-button clicks
// (WHEEL_UP=4 / WHEEL_DOWN=5 / WHEEL_LEFT=6 / WHEEL_RIGHT=7).
let wheelAccumX = 0
let wheelAccumY = 0
const WHEEL_STEP = 60

function handleWheel(event: Extract<GameInputEvent, { type: 'wheel' }>): void {
  wheelAccumX += event.deltaX
  wheelAccumY += event.deltaY
  const emit = (button: number): void => {
    const base = { shift: event.shift, ctrl: event.ctrl, alt: event.alt, meta: event.meta, x: event.x, y: event.y, doubleClick: false, mask: 0 }
    dispatchMouseButtonEvent({ ...base, button, pressed: true })
    dispatchMouseButtonEvent({ ...base, button, pressed: false })
  }
  while (Math.abs(wheelAccumY) >= WHEEL_STEP) {
    emit(wheelAccumY > 0 ? 5 : 4)
    wheelAccumY -= Math.sign(wheelAccumY) * WHEEL_STEP
  }
  while (Math.abs(wheelAccumX) >= WHEEL_STEP) {
    emit(wheelAccumX > 0 ? 7 : 6)
    wheelAccumX -= Math.sign(wheelAccumX) * WHEEL_STEP
  }
}

/**
 * Launch the game. Three presentations, best available first:
 *
 *  - macOS: Godot's embedded display server (--embedded). `visible` attaches
 *    the layer host so the game shows in the game view; a test run stays
 *    off-screen (the game still renders on the GPU — screenshots and probes
 *    work). Test runs embed without the layerhost addon (no layer to attach);
 *    visible runs need it to composite the game into our window.
 *  - Windows: Godot's --wid owned-window embedding + the winhost glue, for
 *    visible play only (test runs have nothing to gain from being glued over
 *    the stage).
 *  - Anywhere else (Linux, failed addon/FFI loads, GAMIFYDESKTOP_WINDOWED=1
 *    which forces this path for debugging): the game plays in its own OS
 *    window over the same debug channel.
 */
async function playNativeEmbedded(godot: string, projectPath: string, visible: boolean): Promise<void> {
  const win = getMainWindow()
  if (!win) throw new Error('Main window unavailable')
  const addon = layerhost()
  const forceWindowed = Boolean(process.env.GAMIFYDESKTOP_WINDOWED)
  const embedded = process.platform === 'darwin' && !forceWindowed && (!visible || addon !== null)
  const winHost = !embedded && !forceWindowed && visible && process.platform === 'win32' ? winhost() : null
  embeddedRun = embedded

  const session = new EmbedSession({
    onContextId: (contextId) => {
      // Configure the game's display *after* its embedded display server is
      // up (this message is our signal): with the default state the GL
      // manager has no valid display id and presents nothing but black.
      session.sendDsState(currentDisplayState(win))
      const rect = stageRect ?? { x: 0, y: 0, width: 640, height: 360 }
      sendStageSizeToGame(session, rect)
      if (visible) {
        addon!.attach(win.getNativeWindowHandle(), contextId, rect.x, rect.y, rect.width, rect.height)
        layerAttached = true
        // attach() shows the layer; honor the renderer's requested visibility
        // in case a modal opened before the game finished launching.
        if (!layerVisibleWanted) addon!.setVisible(false)
        emitLog('[gamifydesktop] game embedded in the GamifyDesktop window (native, full performance)')
        setState({ status: 'running', mode: 'native', view: 'embedded' })
      } else {
        emitLog('[gamifydesktop] game running off-screen for an AI test run')
        testContextId = contextId
        testGameSize = { width: rect.width, height: rect.height }
        // The monitor box may already be on screen (e.g. a second test run in
        // a row) — mirror into it right away instead of waiting for a report.
        updateTestMonitorLayer()
        setState({ status: 'running', mode: 'test', liveView: addon !== null, testGameSize })
      }
      // Give the game keyboard focus semantics right away.
      session.sendNotification(NOTIFICATION.APPLICATION_FOCUS_IN)
      session.sendWinEvent(WIN_EVENT.FOCUS_IN)
    },
    onCursorShape: (shape) => sendToRenderer('game:cursor', shape),
    onDisconnect: () => {
      // Game went away (quit/crash) — tear down if the process exit hasn't already.
      if (state.status !== 'stopped') stopGame()
    },
    onTestReply: (id, ok, text) => {
      const pending = pendingTestReplies.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        pendingTestReplies.delete(id)
        pending.resolve({ ok, text })
      }
    },
    onPerfFrames: handlePerfFrames
  })

  resetPerfWindow()
  const port = await session.listen()
  embedSession = session

  const args = ['--path', projectPath]
  if (embedded) {
    // --embedded renders into a cross-process CAContext instead of opening
    // a window; only the macOS display server implements it.
    args.push('--embedded')
  } else if (winHost) {
    // --wid makes the engine create its window borderless, locked to windowed
    // mode, and OWNED by ours (Godot's Windows equivalent of --embedded; see
    // editor/run/game_view_plugin.cpp). --position/--resolution pre-place it
    // over the stage so it doesn't flash at the project's default position
    // before winhost picks it up. --position is in Godot screen space:
    // physical px relative to the virtual desktop's top-left-most corner.
    const rect = stageRect ?? { x: 0, y: 0, width: 640, height: 360 }
    const sr = stageScreenRect(win, rect)
    const origin = winHost.virtualScreenOrigin()
    args.push('--wid', windowHandleArg(win))
    args.push('--position', `${sr.x - origin.x},${sr.y - origin.y}`)
    args.push('--resolution', `${sr.width}x${sr.height}`)
  }
  args.push('--remote-debug', `tcp://127.0.0.1:${port}`, '--skip-breakpoints')

  const proc = spawn(godot, args, {
    cwd: projectPath,
    env: { ...process.env, PWD: projectPath },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise<void>((resolve, reject) => {
    proc.once('spawn', resolve)
    proc.once('error', reject)
  })
  nativeProcess = proc
  pipeLines(proc.stdout)
  pipeLines(proc.stderr)

  if (!embedded) {
    // No embedded display server → no game_view:set_context_id handshake; the
    // debug connection itself is the "game is up" signal. (The game connects
    // well after this synchronous block, so the assignment can't be late.)
    session.onConnected = () => {
      if (winHost && proc.pid) {
        // Windows: the game window (owned by ours thanks to --wid) is created
        // around now — find it and glue it over the stage.
        beginWinEmbedAttach(session, win, winHost, proc.pid)
      } else if (visible) {
        emitLog('[gamifydesktop] game running in its own window (in-app game view is unavailable on this platform)')
        setState({ status: 'running', mode: 'native', view: 'external' })
      } else {
        emitLog('[gamifydesktop] game running in a separate window for an AI test run')
        setState({ status: 'running', mode: 'test', liveView: false, view: 'external' })
      }
    }
  }
  proc.once('exit', (code, signal) => {
    emitLog(`[gamifydesktop] game exited (${signal ?? `code ${code ?? 0}`})`)
    // Only tear down if this process is still the active run. After a Stop,
    // the old process exits up to 1.5s later (grace period before kill); by
    // then a new run may own nativeProcess/embedSession, and tearing down
    // here would kill that new run.
    if (nativeProcess !== proc) return
    nativeProcess = null
    stopGame()
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function playGame(projectPath: string): Promise<void> {
  if (state.status !== 'stopped') throw new Error('The game is already running')
  const godot = await resolveGodot()
  if (!godot) throw godotMissingError()

  setState({ status: 'starting' })
  try {
    // The agent also runs during user play — it supplies the frame timings
    // behind the FPS counter and .gamifydesktop/perf.log (probe commands stay
    // test-only: runTestCommand refuses outside test mode).
    await cleanupTestAgent(projectPath) // stale files from a crashed run
    await injectTestAgent(projectPath)
    injectedProjectPath = projectPath
    await playNativeEmbedded(godot, projectPath, true)
  } catch (err) {
    stopGame()
    throw err
  }
}

export function stopGame(): void {
  // Flush the in-progress stats window first (needs mode + project path, both
  // still set here); short leftovers are dropped inside drainPerfWindow.
  const finalStats = drainPerfWindow()
  if (finalStats) logPerfStats(finalStats)
  if (nativeProcess) {
    // Ask the game to close cleanly (saves etc.); force-kill if it lingers.
    // Each presentation has its own close channel: the embedded display
    // server takes a close win-event, the owned window takes WM_CLOSE (what
    // the Godot editor posts), and plain windowed runs fall back to the
    // injected agent quitting the scene tree.
    const proc = nativeProcess
    if (embeddedRun) embedSession?.requestClose()
    else if (winAttached) winhost()?.requestClose()
    else embedSession?.sendTestCommand('quit', 0, [])
    setTimeout(() => proc.kill(), 1500)
    nativeProcess = null
  }
  if (layerAttached) {
    layerhost()?.detach()
    layerAttached = false
  }
  stopWinAttachPoll()
  if (winAttached) {
    untrackHostWindow()
    winhost()?.detach()
    winAttached = false
  }
  testContextId = null
  testGameSize = null
  embedSession?.close()
  embedSession = null
  wheelAccumX = 0
  wheelAccumY = 0
  for (const pending of pendingTestReplies.values()) {
    clearTimeout(pending.timer)
    pending.resolve({ ok: false, text: 'game stopped' })
  }
  pendingTestReplies.clear()
  if (injectedProjectPath) {
    void cleanupTestAgent(injectedProjectPath)
    injectedProjectPath = null
  }
  if (state.status !== 'stopped') setState({ status: 'stopped' })
}

// ---------------------------------------------------------------------------
// AI test runs (used by the MCP harness — see test-harness.ts)
// ---------------------------------------------------------------------------

/** Start the game off-screen for an AI test run. */
export async function startGameTest(projectPath: string): Promise<void> {
  if (state.status !== 'stopped') {
    throw new Error('A game is already running. Stop it first (stop_game_test or the Stop button).')
  }
  const godot = await resolveGodot()
  if (!godot) throw godotMissingError()

  logBuffer.length = 0
  testToolCalls = 0
  testRunStart = Date.now()
  setState({ status: 'starting', mode: 'test' })
  try {
    await cleanupTestAgent(projectPath) // stale files from a crashed run
    await injectTestAgent(projectPath)
    injectedProjectPath = projectPath
    await playNativeEmbedded(godot, projectPath, false)
    // Wait until the handshake completes (state flips to running) so tools
    // called right after run_game_test find a live session. Read via the
    // accessor: `state` is mutated from event callbacks TS can't see.
    const deadline = Date.now() + 15000
    while (getGameState().status === 'starting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (getGameState().status !== 'running') {
      throw new Error('The game did not reach a running state — check game_logs for errors.')
    }
  } catch (err) {
    stopGame()
    throw err
  }
}

/** Send a probe command to the injected test agent and await its reply. */
export function runTestCommand(command: string, args: (string | number)[], timeoutMs = 10000): Promise<{ ok: boolean; text: string }> {
  if (!embedSession || state.mode !== 'test' || state.status !== 'running') {
    return Promise.resolve({ ok: false, text: 'No test run is active. Call run_game_test first.' })
  }
  const id = ++testCommandCounter
  const session = embedSession
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingTestReplies.delete(id)
      resolve({ ok: false, text: `test command '${command}' timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    pendingTestReplies.set(id, { resolve, timer })
    session.sendTestCommand(command, id, args)
  })
}

/** One scripted input step from the AI. */
export type TestInputAction =
  | { type: 'key_press'; key: string; holdMs?: number }
  | { type: 'key_down'; key: string }
  | { type: 'key_up'; key: string }
  | { type: 'mouse_click'; x: number; y: number; button?: number }
  | { type: 'mouse_move'; x: number; y: number }
  | { type: 'wait'; ms: number }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Map a friendly key name to DOM key/code fields for the input codec. */
function keyFields(name: string): { key: string; code: string } {
  if (/^[a-zA-Z]$/.test(name)) return { key: name, code: `Key${name.toUpperCase()}` }
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}` }
  if (name === ' ' || name.toLowerCase() === 'space') return { key: ' ', code: 'Space' }
  return { key: name, code: name }
}

/** Execute a sequence of input actions against the running test game. */
export async function runTestInput(actions: TestInputAction[]): Promise<void> {
  if (!embedSession || state.status !== 'running') {
    throw new Error('No running game to send input to.')
  }
  if (actions.length > 200) throw new Error('Too many input actions (max 200 per call).')
  const mods = { shift: false, ctrl: false, alt: false, meta: false }
  const keyEvent = (name: string, pressed: boolean): void => {
    const { key, code } = keyFields(name)
    handleGameInput({ type: 'key', key, code, pressed, echo: false, location: 0, ...mods })
  }
  for (const action of actions) {
    switch (action.type) {
      case 'key_press':
        keyEvent(action.key, true)
        await sleep(Math.min(action.holdMs ?? 60, 2000))
        keyEvent(action.key, false)
        break
      case 'key_down':
        keyEvent(action.key, true)
        break
      case 'key_up':
        keyEvent(action.key, false)
        break
      case 'mouse_click': {
        const button = action.button ?? 0
        const buttons = button === 0 ? 1 : button === 2 ? 2 : 4
        handleGameInput({ type: 'mousemotion', x: action.x, y: action.y, relX: 0, relY: 0, buttons: 0, ...mods })
        handleGameInput({ type: 'mousebutton', button, buttons, pressed: true, doubleClick: false, x: action.x, y: action.y, ...mods })
        await sleep(60)
        handleGameInput({ type: 'mousebutton', button, buttons: 0, pressed: false, doubleClick: false, x: action.x, y: action.y, ...mods })
        break
      }
      case 'mouse_move':
        handleGameInput({ type: 'mousemotion', x: action.x, y: action.y, relX: 0, relY: 0, buttons: 0, ...mods })
        break
      case 'wait':
        await sleep(Math.min(action.ms, 10000))
        break
    }
    // Small gap so the game observes distinct events across frames.
    await sleep(20)
  }
}

export async function openGodotEditor(projectPath: string): Promise<void> {
  const godot = await resolveGodot()
  if (!godot) throw godotMissingError()
  // Detached so the editor outlives GamifyDesktop if the user quits.
  spawn(godot, ['--editor', '--path', projectPath], { detached: true, stdio: 'ignore' }).unref()
}
