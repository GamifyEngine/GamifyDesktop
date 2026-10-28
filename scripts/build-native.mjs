#!/usr/bin/env node
/**
 * Builds the layerhost native addon (macOS only — it hosts the embedded
 * game's CoreAnimation layer inside the GamifyDesktop window). Tolerant of
 * failure so `npm install` still succeeds on machines without a compiler;
 * native embedded play mode simply reports itself unavailable then.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ADDON_DIR = join(ROOT, 'native', 'layerhost')
const BUILT = join(ADDON_DIR, 'build', 'Release', 'layerhost.node')

if (process.platform !== 'darwin') {
  console.log('layerhost addon: skipped (macOS only)')
  process.exit(0)
}
if (existsSync(BUILT)) {
  console.log('✓ layerhost addon already built')
  process.exit(0)
}
try {
  execFileSync('npx', ['node-gyp', 'rebuild'], { cwd: ADDON_DIR, stdio: 'inherit' })
  console.log('✓ layerhost addon built')
} catch {
  console.warn('⚠ layerhost addon build failed (Xcode Command Line Tools missing?).')
  console.warn('  Native embedded play mode will be unavailable; web mode still works.')
}
