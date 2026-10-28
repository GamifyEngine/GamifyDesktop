import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureProjectStateDir } from './chat-history'

/**
 * Frame-rate monitoring for embedded game runs. The injected agent
 * (test-agent.ts) streams per-frame deltas about once per second
 * (`ogperf:frames`); game.ts feeds them in here. Two consumers:
 *
 *  - the FPS counter in the editor's game view (1 Hz updates), and
 *  - .gamifydesktop/perf.log in the project: one stats line per 60-second
 *    window (min / max / avg / 1% low / 0.1% low), written so the AI
 *    assistant can read real frame-rate history — including the user's own
 *    play sessions — when diagnosing performance issues.
 *
 * Percentile lows use the standard frame-time definition: "1% low" is the
 * FPS equivalent of the average frame time of the slowest 1% of frames.
 */

export interface PerfStats {
  /** Wall-clock length of the window (sum of frame deltas), seconds. */
  windowSeconds: number
  frames: number
  avg: number
  min: number
  max: number
  low1: number
  low01: number
}

/** Stats window length. The log gets one line per full window. */
const WINDOW_SECONDS = 60
/** Ignore stop-time leftovers shorter than this — too little data to mean anything. */
const MIN_PARTIAL_SECONDS = 5
/** Safety valve for absurd frame rates (uncapped off-screen runs): flush early. */
const MAX_WINDOW_FRAMES = 200_000
/** perf.log is trimmed to roughly this many recent lines. */
const LOG_MAX_LINES = 500

const LOG_HEADER =
  '# GamifyDesktop frame-rate log — one line per 60s of gameplay (all values in FPS).\n' +
  '# 1%low / 0.1%low = FPS equivalent of the average frame time of the slowest 1% / 0.1% of frames.\n'

let deltas: number[] = []
let elapsed = 0

/** Start a fresh stats window (called when a game run starts). */
export function resetPerfWindow(): void {
  deltas = []
  elapsed = 0
}

function computeStats(windowDeltas: number[], windowSeconds: number): PerfStats | null {
  const valid = windowDeltas.filter((d) => d > 0)
  if (valid.length === 0) return null
  // Slowest frames first (largest delta) for the percentile lows.
  const sorted = [...valid].sort((a, b) => b - a)
  const lowFps = (fraction: number): number => {
    const worst = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * fraction)))
    return worst.length / worst.reduce((a, b) => a + b, 0)
  }
  return {
    windowSeconds,
    frames: valid.length,
    avg: valid.length / windowSeconds,
    min: 1 / sorted[0],
    max: 1 / sorted[sorted.length - 1],
    low1: lowFps(0.01),
    low01: lowFps(0.001)
  }
}

/**
 * Feed one batch of frame deltas (seconds). Returns the FPS to show on the
 * editor's counter, plus completed window stats when a 60s boundary was
 * crossed (the caller logs those).
 */
export function addPerfFrames(batch: number[]): { fps: number | null; completed: PerfStats | null } {
  const batchTime = batch.reduce((a, b) => a + (b > 0 ? b : 0), 0)
  const fps = batchTime > 0 ? batch.length / batchTime : null
  deltas.push(...batch)
  elapsed += batchTime
  let completed: PerfStats | null = null
  if (elapsed >= WINDOW_SECONDS || deltas.length >= MAX_WINDOW_FRAMES) {
    completed = computeStats(deltas, elapsed)
    resetPerfWindow()
  }
  return { fps, completed }
}

/**
 * Flush whatever the current window holds (game stopping). Windows shorter
 * than MIN_PARTIAL_SECONDS are dropped — they'd log noise, not signal.
 */
export function drainPerfWindow(): PerfStats | null {
  const stats = elapsed >= MIN_PARTIAL_SECONDS ? computeStats(deltas, elapsed) : null
  resetPerfWindow()
  return stats
}

const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '0.0')

/** One human/AI-readable stats line (no timestamp — callers add context). */
export function formatPerfStats(stats: PerfStats): string {
  return (
    `window=${stats.windowSeconds.toFixed(1)}s frames=${stats.frames} ` +
    `avg=${fmt(stats.avg)} min=${fmt(stats.min)} max=${fmt(stats.max)} ` +
    `1%low=${fmt(stats.low1)} 0.1%low=${fmt(stats.low01)}`
  )
}

/**
 * Append a stats line to the project's .gamifydesktop/perf.log, keeping the file
 * bounded. Best-effort: perf logging must never break a game run.
 */
export async function appendPerfLog(projectPath: string, mode: string, stats: PerfStats): Promise<void> {
  try {
    const path = join(await ensureProjectStateDir(projectPath), 'perf.log')
    const line = `${new Date().toISOString()} mode=${mode} ${formatPerfStats(stats)}`
    const current = await readFile(path, 'utf8').catch(() => '')
    const lines = current.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
    lines.push(line)
    await writeFile(path, LOG_HEADER + lines.slice(-LOG_MAX_LINES).join('\n') + '\n')
  } catch {
    // Logging is diagnostics, not gameplay — swallow failures.
  }
}
