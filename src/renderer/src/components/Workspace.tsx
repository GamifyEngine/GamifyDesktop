import { useCallback, useEffect, useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import { ChatPanel } from './ChatPanel'
import { FilesPanel } from './FilesPanel'
import { GitPanel } from './GitPanel'
import { FolderIcon, GitBranchIcon, SparkIcon } from './Icons'

type Tab = 'chat' | 'files' | 'git'

interface Props {
  project: ProjectInfo
  width: number
  assistantAvailable: boolean
  advancedMode: boolean
}

const TABS: { id: Tab; label: string; icon: React.JSX.Element }[] = [
  { id: 'chat', label: 'Chat', icon: <SparkIcon /> },
  { id: 'files', label: 'Files', icon: <FolderIcon /> },
  { id: 'git', label: 'Git', icon: <GitBranchIcon /> }
]

/**
 * The right-hand workspace sidebar. All three panels stay mounted (hidden via
 * CSS) so chat history, expanded folders and git state survive tab switches.
 */
export function Workspace({ project, width, assistantAvailable, advancedMode }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('chat')
  // Bumped when the AI finishes work or the window refocuses, so the files
  // and git panels refresh to reflect changes made outside the UI.
  const [workVersion, setWorkVersion] = useState(0)
  const bump = useCallback(() => setWorkVersion((v) => v + 1), [])

  useEffect(() => {
    window.addEventListener('focus', bump)
    // Live refresh while the AI edits files mid-response.
    const offFiles = window.api.onChatFilesChanged(bump)
    return () => {
      window.removeEventListener('focus', bump)
      offFiles()
    }
  }, [bump])

  return (
    <aside className="workspace" style={{ width }}>
      {advancedMode && (
        <nav className="tabbar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="workspace-body">
        <div className="panel" style={{ display: !advancedMode || tab === 'chat' ? 'flex' : 'none' }}>
          <ChatPanel projectPath={project.path} assistantAvailable={assistantAvailable} onAssistantDone={bump} />
        </div>
        <div className="panel" style={{ display: advancedMode && tab === 'files' ? 'flex' : 'none' }}>
          <FilesPanel project={project} refreshToken={workVersion} />
        </div>
        <div className="panel" style={{ display: advancedMode && tab === 'git' ? 'flex' : 'none' }}>
          <GitPanel active={advancedMode && tab === 'git'} refreshToken={workVersion} />
        </div>
      </div>
    </aside>
  )
}
