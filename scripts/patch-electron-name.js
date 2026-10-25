#!/usr/bin/env node
/**
 * Patches the Electron.app bundle to show "SlayZone" in macOS (menu bar and Cmd+Tab) during development.
 * This is a workaround for the known limitation where macOS shows "Electron" in dev mode.
 *
 * What this script does:
 * 1. Renames Electron.app to SlayZone.app
 * 2. Updates path.txt so electron-vite finds the renamed app
 * 3. Patches Info.plist to set CFBundleName and CFBundleDisplayName
 * 4. Replaces electron.icns with app icon (fixes notification icon)
 */

const fs = require('fs')
const path = require('path')

const APP_NAME = 'SlayZoneDev'

// Only run on macOS
if (process.platform !== 'darwin') {
  console.log('Skipping Electron name patch (not macOS)')
  process.exit(0)
}

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron')
const distDir = path.join(electronDir, 'dist')
const oldAppPath = path.join(distDir, 'Electron.app')
const newAppPath = path.join(distDir, `${APP_NAME}.app`)
const pathTxtFile = path.join(electronDir, 'path.txt')

// Step 1: Rename Electron.app to SlayZone.app (if not already renamed)
if (fs.existsSync(oldAppPath)) {
  try {
    fs.renameSync(oldAppPath, newAppPath)
    console.log(`✓ Renamed Electron.app to ${APP_NAME}.app`)
  } catch (err) {
    console.error(`Failed to rename Electron.app: ${err.message}`)
    process.exit(1)
  }
} else if (fs.existsSync(newAppPath)) {
  console.log(`✓ ${APP_NAME}.app already exists`)
} else {
  console.log('Electron.app not found, skipping patch')
  process.exit(0)
}

// Step 2: Update path.txt to point to renamed app
try {
  const newPath = `${APP_NAME}.app/Contents/MacOS/Electron`
  fs.writeFileSync(pathTxtFile, newPath)
  console.log(`✓ Updated path.txt to: ${newPath}`)
} catch (err) {
  console.error(`Failed to update path.txt: ${err.message}`)
  process.exit(1)
}

// Step 3: Patch Info.plist
const plistPath = path.join(newAppPath, 'Contents', 'Info.plist')

if (!fs.existsSync(plistPath)) {
  console.log('Info.plist not found, skipping plist patch')
  process.exit(0)
}

try {
  let plist = fs.readFileSync(plistPath, 'utf-8')

  // Replace CFBundleDisplayName
  plist = plist.replace(
    /<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/,
    `<key>CFBundleDisplayName</key>\n\t<string>${APP_NAME}</string>`
  )

  // Replace CFBundleName
  plist = plist.replace(
    /<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/,
    `<key>CFBundleName</key>\n\t<string>${APP_NAME}</string>`
  )

  // Replace CFBundleIdentifier (busts macOS notification icon cache)
  plist = plist.replace(
    /<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/,
    `<key>CFBundleIdentifier</key>\n\t<string>com.slayzone.dev</string>`
  )

  fs.writeFileSync(plistPath, plist)
  console.log(`✓ Patched Info.plist with app name "${APP_NAME}"`)
} catch (err) {
  console.error(`Failed to patch Info.plist: ${err.message}`)
  process.exit(1)
}

// Step 4: Copy app icon with new name + update CFBundleIconFile to bust macOS cache
const resourcesDir = path.join(newAppPath, 'Contents', 'Resources')
const appIconPath = path.join(__dirname, '..', 'packages', 'apps', 'app', 'build', 'icon.icns')
const targetIconName = 'slayzone.icns'
const targetIconPath = path.join(resourcesDir, targetIconName)

if (fs.existsSync(appIconPath)) {
  try {
    fs.copyFileSync(appIconPath, targetIconPath)
    // Also update Info.plist to point to new icon filename
    let plist2 = fs.readFileSync(plistPath, 'utf-8')
    plist2 = plist2.replace(
      /<key>CFBundleIconFile<\/key>\s*<string>[^<]*<\/string>/,
      `<key>CFBundleIconFile</key>\n\t<string>${targetIconName}</string>`
    )
    fs.writeFileSync(plistPath, plist2)
    console.log(`✓ Installed ${targetIconName} and updated CFBundleIconFile`)
  } catch (err) {
    console.error(`Failed to replace icon: ${err.message}`)
  }
} else {
  console.log('Skipping icon replacement (source icon not found)')
}

// Step 5: The Info.plist edit voids the bundle signature; re-seal it so macOS
// notifications keep working (Electron 42+ needs a signed bundle).
require('./sign-dev-electron').signDevElectron()

console.log(
  `\n✅ Electron patched successfully! "${APP_NAME}" will appear in macOS menu bar and Cmd+Tab.`
)
