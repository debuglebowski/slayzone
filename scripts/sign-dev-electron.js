#!/usr/bin/env node
/**
 * Ad-hoc signs the dev Electron.app bundle (node_modules/electron/dist) on macOS.
 *
 * Since Electron 42, macOS notifications go through UNUserNotificationCenter, which
 * refuses an app without a valid bundle signature: every notification fails with
 * "UNErrorDomain error 1". The npm download only carries the linker's signature on
 * the main binary, which fails `codesign --verify`; a deep ad-hoc signature over the
 * bundle makes dev notifications work again. Packaged builds are signed for real by
 * electron-builder and never use this bundle.
 *
 * Idempotent (skips a bundle that already verifies). Run by scripts/postinstall.js
 * and again by scripts/patch-electron-name.js, whose Info.plist edit voids the seal.
 */

const { execFileSync } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const path = require('path')

function devElectronApp() {
  const electronDir = path.join(__dirname, '..', 'node_modules', 'electron')
  const pathTxt = path.join(electronDir, 'path.txt')
  if (!existsSync(pathTxt)) return null
  // path.txt = "<Name>.app/Contents/MacOS/Electron"
  const bundle = readFileSync(pathTxt, 'utf8').trim().split('/Contents/')[0]
  const app = path.join(electronDir, 'dist', bundle)
  return bundle.endsWith('.app') && existsSync(app) ? app : null
}

function isValidlySigned(app) {
  try {
    execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function signDevElectron() {
  if (process.platform !== 'darwin') return
  const app = devElectronApp()
  if (!app) {
    console.log('Dev Electron.app not found, skipping ad-hoc signing')
    return
  }
  if (isValidlySigned(app)) return
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  console.log(`✓ Ad-hoc signed ${path.basename(app)} (macOS notifications need a signed bundle)`)
}

module.exports = { signDevElectron }

if (require.main === module) signDevElectron()
