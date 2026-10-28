import { useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import logo from '../assets/logo.png'
import { AdvancedToggle } from './AdvancedToggle'
import { DiscordButton } from './DiscordButton'
import { FolderIcon, GearIcon, PlusIcon } from './Icons'

interface Props {
  recents: ProjectInfo[]
  onProjectOpened: (project: ProjectInfo) => void
  onOpenSettings: () => void
  advancedMode: boolean
  onToggleAdvancedMode: (value: boolean) => void
}

/**
 * First screen: create a new game (name + storage location) or open an
 * existing Godot project. This is where the user picks where their game's
 * source code lives on disk.
 */
export function Welcome({
  recents,
  onProjectOpened,
  onOpenSettings,
  advancedMode,
  onToggleAdvancedMode
}: Props): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('My First Game')
  const [parentDir, setParentDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const browse = async (): Promise<void> => {
    const result = await window.api.chooseDirectory()
    if (result.ok && result.data) setParentDir(result.data)
  }

  const create = async (): Promise<void> => {
    if (!name.trim() || !parentDir) return
    setBusy(true)
    setError(null)
    const result = await window.api.createProject(parentDir, name)
    setBusy(false)
    if (result.ok) onProjectOpened(result.data)
    else setError(result.error)
  }

  const openDialog = async (): Promise<void> => {
    setError(null)
    const result = await window.api.openProjectDialog()
    if (result.ok && result.data) onProjectOpened(result.data)
    else if (!result.ok) setError(result.error)
  }

  const openRecent = async (path: string): Promise<void> => {
    setError(null)
    const result = await window.api.openProject(path)
    if (result.ok) onProjectOpened(result.data)
    else setError(result.error)
  }

  const folderSlug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_ ]/g, '')
      .replace(/\s+/g, '-') || 'my-game'

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-head">
          <h1 className="logo">
            <img src={logo} alt="" className="brand-mark-img big" /> GamifyDesktop
          </h1>
          <div className="welcome-head-actions">
            <AdvancedToggle value={advancedMode} onChange={onToggleAdvancedMode} />
            <button
              className="icon-btn"
              title="AI settings (coding agent, 2D & 3D asset generation)"
              onClick={onOpenSettings}
            >
              <GearIcon size={16} />
            </button>
            <DiscordButton />
          </div>
        </div>
        <p className="tagline">The AI game engine. Describe your game — watch it come to life.</p>

        {!creating ? (
          <>
            <div className="welcome-actions">
              <button className="btn btn-primary btn-lg" onClick={() => setCreating(true)}>
                <PlusIcon /> New Game
              </button>
              <button className="btn btn-ghost btn-lg" onClick={openDialog}>
                <FolderIcon /> Open Project
              </button>
            </div>

            {recents.length > 0 && (
              <div className="recents">
                <h2 className="recents-title">Recent</h2>
                {recents.map((r) => (
                  <button key={r.path} className="recent-item" onClick={() => openRecent(r.path)}>
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-path">{r.path}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="new-form">
            <label className="form-row">
              <span className="label">Game name</span>
              <input
                className="text-input"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
              />
            </label>
            <label className="form-row">
              <span className="label">Location</span>
              <div className="path-row">
                <input
                  className="text-input path-input"
                  value={parentDir}
                  placeholder="Choose where to store your game…"
                  onChange={(e) => setParentDir(e.target.value)}
                />
                <button className="btn btn-ghost" onClick={browse}>
                  Browse…
                </button>
              </div>
            </label>
            {parentDir && (
              <p className="path-preview">
                Will create <code>{parentDir}/{folderSlug}</code> with a starter Godot project and a
                git repository.
              </p>
            )}
            <div className="welcome-actions">
              <button
                className="btn btn-primary btn-lg"
                disabled={busy || !name.trim() || !parentDir}
                onClick={create}
              >
                {busy ? 'Creating…' : 'Create Game'}
              </button>
              <button className="btn btn-ghost btn-lg" disabled={busy} onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && <p className="welcome-error">{error}</p>}
      </div>
    </div>
  )
}
