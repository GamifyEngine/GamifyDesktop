import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Configuration of the Codex app-server behind the AI chat. GenieEngine gives
 * Codex a CODEX_HOME of its own (<userData>/codex) instead of the user's
 * ~/.codex, so the app can own the whole config — model provider, tool
 * policy, the game-tester role — without touching (or being broken by) a
 * personal Codex setup, and so Godot-game rules never leak into the user's
 * unrelated terminal sessions. Conversations (threads) persist there too,
 * which is what lets a reopened project continue its chat.
 *
 * Two layers:
 *  - config.toml + game-tester.toml, rewritten at every launch from the
 *    constants below (ensureCodexConfig) — app updates ship prompt and policy
 *    refinements immediately;
 *  - per-spawn `-c` overrides for everything instance-specific: the model
 *    proxy's port and this instance's MCP bridge (codexConfigOverrides).
 *    The config file is shared by every GenieEngine instance (a dev checkout
 *    next to a mounted DMG build), and naming one instance's paths in it
 *    would point the others at a bridge their sandbox can't read — which
 *    silently killed every game tool in a previous version.
 */

/** Codex reads the proxy token from this env var (model_providers.genieengine.env_key). */
export const PROXY_TOKEN_ENV = 'GENIEENGINE_PROXY_TOKEN'

export const GAME_TESTER_AGENT = 'game-tester'

export function codexHome(): string {
  return join(app.getPath('userData'), 'codex')
}

/**
 * Absolute path of a file in the app's resources/ folder: the checkout's
 * resources/ in development, the asar-unpacked copy in packaged builds
 * (asarUnpack covers resources/**, so external processes like the MCP bridge
 * can read these files directly). Null when missing — broken install.
 */
function bundledResource(name: string): string | null {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', name)
    : join(app.getAppPath(), 'resources', name)
  return existsSync(path) ? path : null
}

/**
 * The app-owned build rules (scope, ECS architecture, asset layout, file
 * headers, testing), given to the agent as Codex `developer_instructions`.
 * They live with the app rather than
 *
 *  - in the project's AGENTS.md (which Codex also loads), a creation-time
 *    snapshot that would go stale as the app updates (projects.ts upgrades
 *    old fat copies), or
 *  - anywhere global, where they would leak Godot-game policy into the
 *    user's other Codex sessions.
 *
 * Subagents get their role's instructions instead (see GAME_TESTER_ROLE).
 */
function agentInstructions(): string {
  const path = bundledResource('agent-instructions.md')
  return path ? readFileSync(path, 'utf8') : ''
}

const GAME_TESTER_DESCRIPTION =
  'Plays and verifies the current game end-to-end: launches it (off-screen on macOS, in ' +
  'a separate window on Windows/Linux), sends scripted input, inspects scene tree / ' +
  'state / logs, and checks screenshots it can actually see. Use it after gameplay or ' +
  'visual changes instead of testing yourself; tell it what changed and what to verify, ' +
  'and it reports what works and what is broken.'

const GAME_TESTER_INSTRUCTIONS =
  'You are the game-testing specialist inside GenieEngine, an AI game engine for Godot 4 ' +
  'games. You verify that the current project actually works by playing it with the ' +
  'genieengine MCP tools, then report your findings. You never edit, create or delete ' +
  'files and never generate assets — you test and report so the coding agent can fix. ' +
  'Shell commands are for reading the project (cat, rg, ls) only.\n\n' +
  'Test procedure:\n' +
  '1. run_game_test — start the game (full engine, real rendering; off-screen on macOS, ' +
  'in its own visible window on Windows/Linux — the tools work the same either way).\n' +
  '2. game_logs — check for script errors right away; a broken launch is the most ' +
  'important finding of all.\n' +
  '3. game_scene_tree — discover node paths; game_state evaluates a GDScript expression ' +
  '(e.g. get_node("/root/Main/Score").text) to assert state cheaply.\n' +
  '4. game_input — drive the game with scripted keys/mouse (DOM-style key names like ' +
  '"ArrowLeft", "Space", "Enter"; mouse coordinates in game-view points from the ' +
  'top-left).\n' +
  '5. game_screenshot — capture and LOOK at the rendered frame: verify sprites and art ' +
  'actually display (no missing textures), the layout and HUD are right, and the visuals ' +
  'match what was asked. You can see images — use screenshots as real evidence. To ' +
  'compare against a reference image the caller names, open it with view_image.\n' +
  '6. Re-check game_logs after interacting, then ALWAYS stop_game_test when finished, ' +
  'even after failures.\n\n' +
  'Focus on what the caller asked you to verify, but always report launch errors. Read ' +
  'the project source when you need to know which keys, nodes, or mechanics to ' +
  'exercise.\n\n' +
  'Budget: each run allows ~40 game tool calls / 8 minutes, and every screenshot makes ' +
  'later steps slower — a good test pass finishes in 10-20 tool calls with 2-4 ' +
  'screenshots. Be decisive: check each behavior once (twice at most for something ' +
  'flaky), and the moment a tool result shows a budget warning, stop probing, call ' +
  'stop_game_test, and write your report from the evidence you have. A finding you ' +
  'cannot fully pin down still belongs in the report — describe what you observed; ' +
  'do not keep re-testing it.\n\n' +
  'Report format: a one-line verdict first (works / broken), then evidence per checked ' +
  'item — the state values you probed, what the screenshots show, and any log errors ' +
  'verbatim. Give concrete reproduction steps for every failure. Do not speculate about ' +
  'fixes; describe precisely what is wrong.'

/** A TOML value. JSON string syntax is valid TOML basic-string syntax, escapes included. */
function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)
    return `{ ${entries.join(', ')} }`
  }
  throw new Error(`unsupported TOML value: ${String(value)}`)
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

/** A TOML document from top-level keys plus `[table]` sections (dotted names allowed). */
function tomlDocument(top: Record<string, unknown>, tables: Record<string, Record<string, unknown>>): string {
  const lines = Object.entries(top).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)
  for (const [name, entries] of Object.entries(tables)) {
    lines.push('', `[${name.split('.').map(tomlKey).join('.')}]`)
    for (const [k, v] of Object.entries(entries)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`)
  }
  return lines.join('\n') + '\n'
}

const GENERATED_HEADER =
  '# Generated by GenieEngine at every launch — edits are overwritten.\n' +
  '# Instance-specific values (model proxy, MCP bridge) are passed per spawn as -c overrides.\n\n'

function mainConfig(): string {
  return (
    GENERATED_HEADER +
    tomlDocument(
      {
        // The local model proxy (model-proxy.ts) is the only provider; the
        // model names the chat slot it routes to.
        model_provider: 'genieengine',
        model: 'medium',
        // No approval UI: the agent acts autonomously. Codex's own sandbox
        // stays off because the whole app-server already runs inside the
        // app's macOS seatbelt (chat-sandbox.ts), and seatbelt profiles can't
        // nest — every sandboxed command would fail "Operation not permitted".
        approval_policy: 'never',
        sandbox_mode: 'danger-full-access',
        // Codex's search is a hosted OpenAI tool third-party endpoints don't
        // implement (requests would fail); the agent fetches docs with curl.
        web_search: 'disabled',
        check_for_update_on_startup: false,
        // default_mode_request_user_input is "under development" in 0.164;
        // the per-thread warning about it is noise to us.
        suppress_unstable_features_warning: true,
        developer_instructions: agentInstructions()
      },
      {
        features: {
          // The interactive question tool, outside Plan mode — rendered as
          // the chat's question card (see ChatPanel).
          default_mode_request_user_input: true,
          // Features tied to ChatGPT accounts or OpenAI-hosted tools, plus
          // tools a game-building agent shouldn't be distracted by.
          goals: false,
          memories: false,
          apps: false,
          plugins: false,
          remote_plugin: false,
          image_generation: false,
          browser_use: false,
          computer_use: false,
          tool_suggest: false
        },
        // Codex's bundled skills (image generation, OpenAI docs, …) would
        // compete with the genieengine asset tools.
        skills: { include_instructions: false },
        'skills.bundled': { enabled: false },
        // Codex 0.164 hands the agent's shell commands the app-server's whole
        // environment by default. Drop *KEY* / *SECRET* / *TOKEN* variables
        // (the proxy token, the harness token, any API key in a developer's
        // env); the MCP bridge gets the harness token through its own
        // env_vars allowlist instead (codexConfigOverrides).
        shell_environment_policy: { ignore_default_excludes: false },
        history: { persistence: 'none' },
        analytics: { enabled: false },
        feedback: { enabled: false },
        [`agents.${GAME_TESTER_AGENT}`]: {
          description: GAME_TESTER_DESCRIPTION,
          config_file: `${GAME_TESTER_AGENT}.toml`
        }
      }
    )
  )
}

/**
 * The game-tester role's config layer. Test-and-report only: no subagents of
 * its own, and no blocking questions (nobody is watching a subagent). Shell
 * stays available because Codex reads files through it; that it must not
 * edit anything is in its instructions.
 */
function gameTesterConfig(): string {
  return (
    GENERATED_HEADER +
    tomlDocument(
      { developer_instructions: GAME_TESTER_INSTRUCTIONS },
      { features: { multi_agent: false, default_mode_request_user_input: false } }
    )
  )
}

/** Rewrite the app-owned config files. Called at startup, before any chat server spawns. */
export async function ensureCodexConfig(): Promise<void> {
  try {
    const home = codexHome()
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'config.toml'), mainConfig())
    await writeFile(join(home, `${GAME_TESTER_AGENT}.toml`), gameTesterConfig())
  } catch (err) {
    console.error('[genieengine] failed to write the Codex config:', err)
  }
}

/** Env vars the MCP bridge needs from the app-server's environment (Codex passes MCP servers a minimal env). */
const BRIDGE_ENV_VARS = ['GENIEENGINE_HARNESS_PORT', 'GENIEENGINE_HARNESS_TOKEN']

/**
 * This instance's `-c` overrides: the model provider pointing at this
 * instance's proxy, and the genieengine MCP server — the game-testing bridge,
 * run with the app's own binary in Node mode (ELECTRON_RUN_AS_NODE) so users
 * don't need Node installed. Without the bridge script (broken install) the
 * chat still works, minus game tools.
 */
export function codexConfigOverrides(proxyBaseUrl: string): string[] {
  const overrides: Record<string, unknown> = {
    'model_providers.genieengine': {
      name: 'GenieEngine',
      base_url: proxyBaseUrl,
      env_key: PROXY_TOKEN_ENV,
      wire_api: 'responses'
    }
  }
  const bridge = bundledResource('mcp-bridge.mjs')
  if (bridge) {
    overrides['mcp_servers.genieengine'] = {
      command: process.execPath,
      args: [bridge],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      env_vars: BRIDGE_ENV_VARS,
      startup_timeout_sec: 30,
      // 3D generation alone takes 1-5 minutes; Codex's default would cut it off.
      tool_timeout_sec: 900
    }
  }
  return Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${tomlValue(value)}`])
}
