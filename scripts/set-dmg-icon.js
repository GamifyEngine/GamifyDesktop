// electron-builder afterAllArtifactBuild hook: give the .dmg artifact itself
// the GamifyDesktop icon in Finder. electron-builder already sets the *volume*
// icon (shown once mounted), but the downloadable .dmg file would otherwise
// carry the generic disk-image icon. Uses the classic sips/DeRez/Rez recipe:
// embed an icon resource into a copy of the app icon, extract it, append it
// to the dmg's resource fork, and flip Finder's custom-icon flag.
'use strict'
const { execFileSync } = require('node:child_process')
const { copyFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

// The DeRez text dump of a multi-resolution icns runs to several MB.
const xcrun = (tool, args, opts = {}) =>
  execFileSync('xcrun', [tool, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts })

module.exports = async function setDmgIcon(buildResult) {
  if (process.platform !== 'darwin') return []
  const dmgs = buildResult.artifactPaths.filter((p) => p.endsWith('.dmg'))
  for (const dmg of dmgs) {
    const tmpIcon = join(buildResult.outDir, 'dmg-file-icon.png')
    const tmpRsrc = join(buildResult.outDir, 'dmg-file-icon.rsrc')
    try {
      copyFileSync(join(__dirname, '..', 'build', 'icon.png'), tmpIcon)
      xcrun('sips', ['-i', tmpIcon], { stdio: 'ignore' })
      writeFileSync(tmpRsrc, xcrun('DeRez', ['-only', 'icns', tmpIcon]))
      xcrun('Rez', ['-append', tmpRsrc, '-o', dmg])
      xcrun('SetFile', ['-a', 'C', dmg])
      console.log(`  • stamped Finder icon onto ${dmg}`)
    } catch (err) {
      // Cosmetic step — never fail the whole build over it.
      console.warn(`  • could not set dmg icon: ${err.message}`)
    } finally {
      rmSync(tmpIcon, { force: true })
      rmSync(tmpRsrc, { force: true })
    }
  }
  return []
}
