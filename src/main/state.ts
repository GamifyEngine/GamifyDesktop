import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatModelTier, ReasoningEffort, ThinkingMode, ProjectInfo } from '../shared/types'

/**
 * One chat model slot's non-secret settings. Its API key lives in its own
 * owner-only credential file instead (see chat-setup.ts), never in here.
 */
export interface ChatSlotSettings {
  /** Base URL of the Responses-API endpoint, e.g. https://openrouter.ai/api/v1. */
  endpoint: string
  model: string
  thinking: ThinkingMode
  effort: ReasoningEffort
}

/**
 * How versions ≤ 0.1.2 stored the chat models: OpenCode `provider/model`
 * refs, with endpoints and keys in OpenCode's own config files. Read once to
 * migrate existing setups (see migrateLegacySetup in chat-setup.ts).
 */
export interface LegacyChatModelRefs {
  medium?: string
  large?: string
}

interface SettingsFile {
  godotPath?: string
  codexPath?: string
  recentProjects: string[]
  /** Whether the ECS viewer, files/git sidebars and console output are shown. */
  advancedMode?: boolean
  chatSlots?: Partial<Record<ChatModelTier, ChatSlotSettings>>
  chatModels?: LegacyChatModelRefs
}

let settings: SettingsFile = { recentProjects: [] }
let currentProject: ProjectInfo | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): void {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<SettingsFile>
    settings = { recentProjects: [], ...raw }
  } catch {
    // First launch (or corrupt file) — start with defaults.
    settings = { recentProjects: [] }
  }
}

export function saveSettings(): void {
  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2))
}

export function getSettings(): SettingsFile {
  return settings
}

export function setGodotPath(path: string): void {
  settings.godotPath = path
  saveSettings()
}

/** Stored slot settings — unset until the first setup save (or legacy migration). */
export function getChatSlotSettings(): SettingsFile['chatSlots'] {
  return settings.chatSlots
}

export function setChatSlotSettings(slots: Record<ChatModelTier, ChatSlotSettings>): void {
  settings.chatSlots = slots
  saveSettings()
}

export function getAdvancedMode(): boolean {
  return settings.advancedMode ?? false
}

export function setAdvancedMode(value: boolean): void {
  settings.advancedMode = value
  saveSettings()
}

export function addRecentProject(path: string): void {
  settings.recentProjects = [path, ...settings.recentProjects.filter((p) => p !== path)].slice(0, 8)
  saveSettings()
}

export function getRecentProjectPaths(): string[] {
  // Drop projects whose folder no longer exists so the welcome screen stays clean.
  return settings.recentProjects.filter((p) => existsSync(p))
}

export function setCurrentProject(project: ProjectInfo | null): void {
  currentProject = project
}

export function getCurrentProject(): ProjectInfo | null {
  return currentProject
}

export function requireProject(): ProjectInfo {
  if (!currentProject) throw new Error('No project is open')
  return currentProject
}
