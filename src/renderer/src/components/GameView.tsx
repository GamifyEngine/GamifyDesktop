import { useCallback, useEffect, useRef, useState } from 'react'
import type { AspectMode, GameInputModifiers, GameState } from '../../../shared/types'
import { PlayIcon, StopIcon, XIcon } from './Icons'

/** width/height ratios for enforced preview shapes (modern phones ≈ 19.5:9). */
const ASPECT_RATIOS: Partial<Record<AspectMode, number>> = {
  desktop: 16 / 9,
  'mobile-portrait': 9 / 19.5,
  'mobile-landscape': 19.5 / 9
}

/** Godot CursorShape → CSS cursor (servers/display DisplayServer::CursorShape order). */
const GODOT_CURSORS = [
  'default', 'text', 'pointer', 'crosshair', 'wait', 'progress', 'grabbing', 'copy', 'not-allowed',
  'ns-resize', 'ew-resize', 'nesw-resize', 'nwse-resize', 'move', 'row-resize', 'col-resize', 'help'
]

function modifiers(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): GameInputModifiers {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }
}

/**
 * Captures input over the embedded native game (which renders as a layer
 * behind this transparent element) and forwards it to the game process.
 */
function NativeGameOverlay(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState('default')

  useEffect(() => window.api.onGameCursor((shape) => setCursor(GODOT_CURSORS[shape] ?? 'default')), [])

  // Focus the game as soon as it appears so keyboard input works immediately.
  useEffect(() => {
    ref.current?.focus()
  }, [])

  const pos = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const rect = ref.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.x ?? 0), y: e.clientY - (rect?.y ?? 0) }
  }, [])

  return (
    <div
      ref={ref}
      className="native-overlay"
      style={{ cursor }}
      tabIndex={0}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.preventDefault()
        window.api.sendGameInput({
          type: 'key', key: e.key, code: e.code, pressed: true, echo: e.repeat,
          location: e.location, ...modifiers(e)
        })
      }}
      onKeyUp={(e) => {
        e.preventDefault()
        window.api.sendGameInput({
          type: 'key', key: e.key, code: e.code, pressed: false, echo: false,
          location: e.location, ...modifiers(e)
        })
      }}
      onMouseDown={(e) => {
        ref.current?.focus()
        window.api.sendGameInput({
          type: 'mousebutton', button: e.button, buttons: e.buttons, pressed: true,
          doubleClick: e.detail === 2, ...pos(e), ...modifiers(e)
        })
      }}
      onMouseUp={(e) =>
        window.api.sendGameInput({
          type: 'mousebutton', button: e.button, buttons: e.buttons, pressed: false,
          doubleClick: false, ...pos(e), ...modifiers(e)
        })
      }
      onMouseMove={(e) =>
        window.api.sendGameInput({
          type: 'mousemotion', ...pos(e), relX: e.movementX, relY: e.movementY,
          buttons: e.buttons, ...modifiers(e)
        })
      }
      onWheel={(e) =>
        window.api.sendGameInput({ type: 'wheel', ...pos(e), deltaX: e.deltaX, deltaY: e.deltaY, ...modifiers(e) })
      }
      onMouseEnter={() => window.api.sendGameInput({ type: 'enter' })}
      onMouseLeave={() => window.api.sendGameInput({ type: 'leave' })}
      onFocus={() => window.api.sendGameInput({ type: 'focus' })}
      onBlur={() => window.api.sendGameInput({ type: 'blur' })}
    />
  )
}

/**
 * Live monitor for an AI test run. The off-screen game is composited into
 * the screen box by the main process as a scaled-down native layer (above
 * the web contents, like normal embedded play) — this element letterbox-fits
 * the screen into the flexible monitor area and reports where it sits. It
 * takes no input: the native layer hit-tests nil and no input overlay is
 * mounted, so the AI's run can't be disturbed by clicks.
 */
function TestLiveMonitor({ gameSize }: { gameSize: { width: number; height: number } }): React.JSX.Element {
  const areaRef = useRef<HTMLDivElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const area = areaRef.current
    const screen = screenRef.current
    const shell = screen?.parentElement
    if (!area || !screen || !shell) return
    const layout = (): void => {
      const rect = area.getBoundingClientRect()
      // Hidden behind another center tab (display:none → 0×0) — skip; a real
      // rect is re-reported when the tab becomes visible again.
      if (rect.width < 2 || rect.height < 2) return
      // The shell's bezel (padding + border) around the screen, whatever the
      // stylesheet currently says.
      const chromeX = shell.offsetWidth - screen.offsetWidth
      const chromeY = shell.offsetHeight - screen.offsetHeight
      const scale = Math.min((rect.width - chromeX) / gameSize.width, (rect.height - chromeY) / gameSize.height)
      const width = Math.floor(gameSize.width * scale)
      const height = Math.floor(gameSize.height * scale)
      if (width < 8 || height < 8) {
        // No room (e.g. the console dragged almost to the top) — a 0-rect
        // tells the main process to park the layer off-screen.
        screen.style.width = '0px'
        screen.style.height = '0px'
        window.api.setTestMonitorBounds({ x: 0, y: 0, width: 0, height: 0 })
        return
      }
      screen.style.width = `${width}px`
      screen.style.height = `${height}px`
      // The shell centers in the area, so the screen's final rect is known
      // now — no need to wait for the style to be laid out.
      window.api.setTestMonitorBounds({
        x: rect.x + (rect.width - width) / 2,
        y: rect.y + (rect.height - height) / 2,
        width,
        height
      })
    }
    layout()
    const observer = new ResizeObserver(layout)
    observer.observe(area)
    // The area only RESIZES for height changes; sidebar/window drags can MOVE
    // it without resizing (the card's width is capped). Every such move comes
    // from a stage resize, so watching the stage catches them all.
    const stage = area.closest('.game-stage')
    if (stage) observer.observe(stage)
    return () => observer.disconnect()
  }, [gameSize])
  return (
    <div ref={areaRef} className="test-monitor-area">
      <div className="test-monitor-shell">
        <div ref={screenRef} className="test-monitor-screen" />
      </div>
    </div>
  )
}

interface Props {
  state: GameState
  error: string | null
  godotPath: string | null
  aspect: AspectMode
  onPlay: () => void
  onStop: () => void
  onLocateGodot: () => void
  onDismissError: () => void
  advancedMode: boolean
}

const MAX_LOG_LINES = 500
const CONSOLE_HEIGHT_KEY = 'gamifydesktop:consoleHeight'
const CONSOLE_MIN = 80
const CONSOLE_MAX = 600

/**
 * Center stage. Run renders the full native engine embedded in this view
 * (via the layerhost compositing pipeline); the transparent overlay captures
 * input. AI test runs show a live monitor card instead.
 */
export function GameView({
  state,
  error,
  godotPath,
  aspect,
  onPlay,
  onStop,
  onLocateGodot,
  onDismissError,
  advancedMode
}: Props): React.JSX.Element {
  const [logs, setLogs] = useState<string[]>([])
  const [testShot, setTestShot] = useState<string | null>(null)
  const consoleRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLElement>(null)

  // Console height, drag-resizable like the sidebar (persisted).
  const [consoleHeight, setConsoleHeight] = useState(() => {
    const saved = Number(localStorage.getItem(CONSOLE_HEIGHT_KEY))
    return saved >= CONSOLE_MIN && saved <= CONSOLE_MAX ? saved : 160
  })

  const onConsoleDrag = useCallback((down: React.MouseEvent) => {
    down.preventDefault()
    document.body.classList.add('resizing-v')
    const onMove = (e: MouseEvent): void => {
      const bottom = areaRef.current?.getBoundingClientRect().bottom ?? window.innerHeight
      const maxH = Math.min(CONSOLE_MAX, (areaRef.current?.getBoundingClientRect().height ?? 800) - 120)
      setConsoleHeight(Math.min(maxH, Math.max(CONSOLE_MIN, bottom - e.clientY)))
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing-v')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setConsoleHeight((h) => {
        localStorage.setItem(CONSOLE_HEIGHT_KEY, String(h))
        return h
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Live monitor: show the latest screenshot the AI captured while testing.
  useEffect(() => window.api.onGameTestShot(setTestShot), [])
  useEffect(() => {
    if (state.status !== 'running' || state.mode !== 'test') setTestShot(null)
  }, [state])

  // Frame rate measured inside the game process (~1 update/s while running).
  const [fps, setFps] = useState<number | null>(null)
  useEffect(() => window.api.onGameFps(setFps), [])
  useEffect(() => {
    if (state.status !== 'running') setFps(null)
  }, [state])

  // Keep the main process aware of where the game should render. With an
  // enforced aspect ratio the game frame is the largest centered rect of that
  // shape inside the stage — the stage's black background forms the bars.
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const report = (): void => {
      const rect = el.getBoundingClientRect()
      // Hidden behind another center tab (display:none → 0×0): reporting that
      // would resize the running game's window to nothing. Skip; a real rect
      // is re-reported the moment the tab becomes visible again.
      if (rect.width < 2 || rect.height < 2) return
      const ratio = ASPECT_RATIOS[aspect]
      let width = rect.width
      let height = rect.height
      if (ratio) {
        if (rect.width / rect.height > ratio) {
          height = rect.height
          width = height * ratio
        } else {
          width = rect.width
          height = width / ratio
        }
        setFrameSize({ width, height })
      } else {
        setFrameSize(null)
      }
      window.api.setGameStageBounds({
        x: rect.x + (rect.width - width) / 2,
        y: rect.y + (rect.height - height) / 2,
        width,
        height
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [aspect])

  useEffect(
    () =>
      window.api.onGameLog((line) => {
        setLogs((prev) => [...prev, line].slice(-MAX_LOG_LINES))
      }),
    []
  )

  useEffect(() => {
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  const renderStage = (): React.JSX.Element => {
    if (state.status === 'starting') {
      return (
        <div className="game-idle">
          <div className="spinner big" />
          <h2>Starting your game…</h2>
        </div>
      )
    }
    if (state.status === 'running' && state.mode === 'test') {
      const live = state.liveView === true && state.testGameSize !== undefined
      return (
        <div className={live ? 'game-running-card live' : 'game-running-card'}>
          <span className="status-dot starting big" />
          <h2>AI test run in progress</h2>
          <p className="muted">
            {live
              ? 'Watch live as the assistant plays your game and checks its state.'
              : testShot
                ? 'Latest screenshot the assistant captured:'
                : state.view === 'external'
                  ? 'The assistant is playing your game in its own window — screenshots it captures will appear here.'
                  : 'The assistant is running your game off-screen — playing it, taking screenshots and checking its state.'}
          </p>
          {live ? (
            <TestLiveMonitor gameSize={state.testGameSize!} />
          ) : (
            testShot && <img className="test-monitor" src={testShot} alt="Latest AI test screenshot" />
          )}
          <button className="btn btn-stop" onClick={onStop}>
            <StopIcon size={12} /> Stop
          </button>
        </div>
      )
    }
    if (state.status === 'running') {
      // Windowed fallback (no embedding available on this platform): the game
      // plays in its own OS window; the stage just shows status.
      if (state.view === 'external') {
        return (
          <div className="game-running-card">
            <span className="status-dot starting big" />
            <h2>Your game is running in its own window</h2>
            <p className="muted">
              The in-app game view isn't available here, so your game opened as a separate
              window. Play it there, and press Stop here when you're done.
            </p>
            <button className="btn btn-stop" onClick={onStop}>
              <StopIcon size={12} /> Stop
            </button>
          </div>
        )
      }
      // Windows owned-window embed: the game's borderless window is glued
      // exactly over this frame by the main process, and the OS routes input
      // to it directly — mount no overlay, just keep the frame shape.
      if (state.view === 'embedded-window') {
        return <div className="game-frame-box" style={frameSize ?? { width: '100%', height: '100%' }} />
      }
      // Native embedded (macOS): the game renders as a native layer exactly
      // behind this transparent frame, which captures and forwards input. The
      // frame matches the (possibly letterboxed) game rect.
      return (
        <div className="game-frame-box" style={frameSize ?? { width: '100%', height: '100%' }}>
          <NativeGameOverlay />
        </div>
      )
    }
    return (
      <div className="game-idle">
        <button className="play-hero" onClick={onPlay} title="Run your game">
          <PlayIcon size={30} />
        </button>
        <h2>Press Run to start your game</h2>
        <p className="muted">
          Your game runs right here in GamifyDesktop. Ask the assistant in the chat to build or change
          anything.
        </p>
        {!godotPath && (
          <button className="warning-chip" onClick={onLocateGodot}>
            Bundled Godot engine missing — reinstall GamifyDesktop, or click to locate one
          </button>
        )}
      </div>
    )
  }

  const embedded = state.status === 'running'

  // The FPS readout lives in a strip ABOVE the stage: the native game layer
  // is composited over the web contents, so DOM drawn inside the stage rect
  // would be invisible behind the running game.
  const showFpsBar = embedded && state.mode === 'native'

  return (
    <section className="game-area" ref={areaRef}>
      {showFpsBar && (
        <div className="stage-toolbar">
          <span
            className={`fps-badge${fps !== null && fps < 30 ? ' bad' : fps !== null && fps < 50 ? ' warn' : ''}`}
            title="Frame rate measured in the game process. Per-minute stats (min/max/avg/1% low/0.1% low) are logged to .gamifydesktop/perf.log"
          >
            {fps !== null ? `${Math.round(fps)} FPS` : '— FPS'}
          </span>
        </div>
      )}
      <div ref={stageRef} className={embedded ? 'game-stage embedded' : 'game-stage'}>
        {error && (
          <div className="error-banner">
            <span className="error-text">{error}</span>
            <span className="banner-actions">
              {error.toLowerCase().includes('godot') && (
                <button className="btn btn-sm btn-ghost" onClick={onLocateGodot}>
                  Locate Godot…
                </button>
              )}
              <button className="icon-btn" onClick={onDismissError} title="Dismiss">
                <XIcon size={12} />
              </button>
            </span>
          </div>
        )}
        {renderStage()}
      </div>

      {advancedMode && (
        <>
          <div className="console-resize" onMouseDown={onConsoleDrag} title="Drag to resize console" />
          <div className="game-console" style={{ height: consoleHeight }}>
            <div className="console-header">
              <span className="console-title">Output</span>
              <button className="btn btn-sm btn-ghost" onClick={() => setLogs([])}>
                Clear
              </button>
            </div>
            <div className="console-body" ref={consoleRef}>
              {logs.length === 0 ? (
                <span className="console-line muted">Game console output will appear here.</span>
              ) : (
                logs.map((line, i) => (
                  <span key={i} className="console-line">
                    {line}
                  </span>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
