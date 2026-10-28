import { useCallback, useEffect, useRef, useState } from 'react'
import type { AspectMode, GameState, InitialState, ProjectInfo, SetupStatus } from '../../shared/types'
import { EcsPanel } from './components/EcsPanel'
import { ExportModal } from './components/ExportModal'
import { GameView } from './components/GameView'
import { SetupOverlay } from './components/SetupOverlay'
import { TitleBar } from './components/TitleBar'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'

/** Which panel occupies the center pane. */
type CenterView = 'game' | 'ecs'

const SIDEBAR_WIDTH_KEY = 'gamifydesktop:sidebarWidth'
const ASPECT_KEY = 'gamifydesktop:aspect'
const ASPECT_MODES: AspectMode[] = ['any', 'desktop', 'mobile-portrait', 'mobile-landscape']
// "3 inch" workspace sidebar ≈ 288px at 96dpi; default slightly wider.
const SIDEBAR_DEFAULT = 300
const SIDEBAR_MIN = 260
const SIDEBAR_MAX = 560

export function App(): React.JSX.Element {
  const [booted, setBooted] = useState(false)
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [recents, setRecents] = useState<ProjectInfo[]>([])
  const [godotPath, setGodotPath] = useState<string | null>(null)
  const [codexPath, setCodexPath] = useState<string | null>(null)

  const [gameState, setGameState] = useState<GameState>({ status: 'stopped' })
  const [gameError, setGameError] = useState<string | null>(null)
  const [aspect, setAspectState] = useState<AspectMode>(() => {
    const saved = localStorage.getItem(ASPECT_KEY) as AspectMode | null
    return saved && ASPECT_MODES.includes(saved) ? saved : 'any'
  })

  const setAspect = useCallback((mode: AspectMode) => {
    localStorage.setItem(ASPECT_KEY, mode)
    setAspectState(mode)
  }, [])

  const [exportOpen, setExportOpen] = useState(false)
  const [centerView, setCenterView] = useState<CenterView>('game')

  // Advanced mode gates the ECS viewer, files/git sidebars and console
  // output. Persisted in the main-process settings file (not localStorage)
  // since it applies on the home page too, before any project is open.
  const [advancedMode, setAdvancedModeState] = useState(false)
  // Drives whether `.titlebar` reserves room for the macOS traffic lights —
  // they disappear in native fullscreen, so the reserved gap should too.
  const [isFullScreen, setIsFullScreen] = useState(false)
  useEffect(() => window.api.onFullscreenChange(setIsFullScreen), [])
  const setAdvancedMode = useCallback((value: boolean) => {
    setAdvancedModeState(value)
    void window.api.setAdvancedMode(value)
  }, [])
  // Dropping out of advanced mode while the ECS tab is open falls back to
  // the game view, since the tab that opened it just disappeared.
  useEffect(() => {
    if (!advancedMode) setCenterView('game')
  }, [advancedMode])

  // AI provider setup: fetched app-wide (not project-scoped) so the settings
  // gear works from both the title bar and the welcome screen. Re-checked on
  // window focus so a setup completed elsewhere (another GamifyDesktop window
  // or instance) clears the overlay without a restart.
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => {
    const check = (): void => {
      void window.api.getSetupStatus().then((r) => {
        if (r.ok) setSetup(r.data)
      })
    }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  const assistantAvailable = codexPath !== null
  // Gates chat until an API key is connected — only forced once a project is
  // open, since that's the earliest point the assistant is actually used.
  const needsSetup = project !== null && assistantAvailable && setup !== null && !setup.configured

  // The embedded game renders as a native layer the OS composites above the
  // web contents — DOM can't cover it, so hide it while the ECS tab is open
  // or while a modal (settings/export) is up; mirrors their render conditions.
  const modalOpen = (exportOpen && project !== null) || ((needsSetup || settingsOpen) && setup !== null)
  useEffect(() => {
    window.api.setGameLayerVisible(centerView === 'game' && !modalOpen)
  }, [centerView, modalOpen])

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT
  })

  useEffect(() => {
    window.api.getInitialState().then((result) => {
      if (result.ok) {
        const state: InitialState = result.data
        setProject(state.project)
        setRecents(state.recentProjects)
        setGodotPath(state.godotPath)
        setCodexPath(state.codexPath)
        setAdvancedModeState(state.advancedMode)
        setIsFullScreen(state.isFullScreen)
      }
      setBooted(true)
    })
  }, [])

  useEffect(() => window.api.onGameState(setGameState), [])

  const handleProjectOpened = useCallback((opened: ProjectInfo) => {
    setProject(opened)
    setGameError(null)
    setGameState({ status: 'stopped' })
    setCenterView('game')
  }, [])

  const goHome = useCallback(async () => {
    await window.api.closeProject()
    const result = await window.api.getInitialState()
    if (result.ok) setRecents(result.data.recentProjects)
    setProject(null)
    setGameState({ status: 'stopped' })
    setGameError(null)
    setCenterView('game')
  }, [])

  const play = useCallback(async () => {
    setGameError(null)
    // Always show the game the user just started.
    setCenterView('game')
    const result = await window.api.playGame()
    if (!result.ok) setGameError(result.error)
  }, [])

  const stop = useCallback(() => {
    void window.api.stopGame()
  }, [])

  const locateGodot = useCallback(async () => {
    const result = await window.api.locateGodot()
    if (result.ok && result.data) {
      setGodotPath(result.data)
      setGameError(null)
    } else if (!result.ok) {
      setGameError(result.error)
    }
  }, [])

  // Sidebar drag-resize: track the pointer on the whole window while dragging.
  const dragging = useRef(false)
  const onDividerMouseDown = useCallback(() => {
    dragging.current = true
    document.body.classList.add('resizing')
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, window.innerWidth - e.clientX))
      setSidebarWidth(width)
    }
    const onUp = (): void => {
      dragging.current = false
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setSidebarWidth((w) => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w))
        return w
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const platformClass =
    window.api.platform === 'darwin' ? `app mac${isFullScreen ? ' fullscreen' : ''}` : 'app'

  if (!booted) return <div className={platformClass} />

  return (
    <div className={platformClass}>
      <TitleBar
        project={project}
        gameState={gameState}
        aspect={aspect}
        onSetAspect={setAspect}
        onPlay={play}
        onStop={stop}
        onHome={goHome}
        onExport={() => setExportOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        advancedMode={advancedMode}
        onToggleAdvancedMode={setAdvancedMode}
      />
      {exportOpen && project && <ExportModal projectName={project.name} onClose={() => setExportOpen(false)} />}
      {(needsSetup || settingsOpen) && setup && (
        <SetupOverlay
          status={setup}
          onStatusChange={setSetup}
          onClose={needsSetup ? undefined : () => setSettingsOpen(false)}
        />
      )}
      {project ? (
        <div className="content-row">
          <div className="center-pane">
            {advancedMode && (
              <div className="center-tabs">
                <button
                  className={centerView === 'game' ? 'center-tab active' : 'center-tab'}
                  onClick={() => setCenterView('game')}
                >
                  Game
                </button>
                <button
                  className={centerView === 'ecs' ? 'center-tab active' : 'center-tab'}
                  onClick={() => setCenterView('ecs')}
                >
                  ECS
                </button>
              </div>
            )}
            {/* GameView stays mounted while hidden so the run, its console
                output and the input overlay survive tab switches. */}
            <div className="center-body" style={{ display: !advancedMode || centerView === 'game' ? undefined : 'none' }}>
              <GameView
                state={gameState}
                error={gameError}
                godotPath={godotPath}
                aspect={aspect}
                onPlay={play}
                onStop={stop}
                onLocateGodot={locateGodot}
                onDismissError={() => setGameError(null)}
                advancedMode={advancedMode}
              />
            </div>
            {advancedMode && centerView === 'ecs' && <EcsPanel key={project.path} />}
          </div>
          <div className="divider" onMouseDown={onDividerMouseDown} />
          <Workspace
            key={project.path}
            project={project}
            width={sidebarWidth}
            assistantAvailable={assistantAvailable}
            chatSource={setup?.source ?? 'custom'}
            advancedMode={advancedMode}
          />
        </div>
      ) : (
        <Welcome
          recents={recents}
          onProjectOpened={handleProjectOpened}
          onOpenSettings={() => setSettingsOpen(true)}
          advancedMode={advancedMode}
          onToggleAdvancedMode={setAdvancedMode}
        />
      )}
    </div>
  )
}
