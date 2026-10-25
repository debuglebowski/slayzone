#!/usr/bin/env node

// Stamps `minimumSystemVersion` into the macOS auto-update manifest (latest-mac.yml).
//
// electron-updater (since 6.3, so every SlayZone release in the field) skips an update
// whose manifest says the current OS is too old. electron-builder never writes the key,
// so without it a Mac below the new Electron's minimum would download an update that
// macOS then refuses to open. Electron 44 raised the minimum to macOS 13.
//
// The value comes from the packaged app's own LSMinimumSystemVersion (inherited from
// Electron's Info.plist), so it tracks every future Electron bump with no edit here.
// electron-updater compares it against os.release(), the DARWIN kernel version, not
// the macOS marketing version, so it is converted.
//
// Usage: stamp-min-system-version.mjs --dist <electron-builder output dir>

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** macOS marketing version → the Darwin kernel version os.release() reports on it. */
export function darwinVersionForMacos(macosVersion) {
  const major = Number.parseInt(String(macosVersion).split('.')[0], 10)
  if (!Number.isInteger(major) || major < 11) {
    throw new Error(`Unsupported LSMinimumSystemVersion: ${macosVersion}`)
  }
  // macOS 11–15 run Darwin 20–24; macOS 26 (the year-based numbering) runs Darwin 25.
  const darwinMajor = major >= 26 ? major - 1 : major + 9
  return `${darwinMajor}.0.0`
}

/** Returns the manifest with `minimumSystemVersion` set (replacing any existing value). */
export function stampMinimumSystemVersion(manifestText, darwinVersion) {
  const lines = manifestText.split('\n').filter((l) => !l.startsWith('minimumSystemVersion:'))
  const at = lines.findIndex((l) => l.startsWith('releaseDate:'))
  const line = `minimumSystemVersion: ${darwinVersion}`
  if (at === -1) {
    const end = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    lines.splice(end, 0, line)
  } else {
    lines.splice(at, 0, line)
  }
  return lines.join('\n')
}

function readMinimumMacos(distDir) {
  for (const sub of readdirSync(distDir)) {
    if (!sub.startsWith('mac')) continue
    const dir = join(distDir, sub)
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.app')) continue
      const plist = join(dir, entry, 'Contents', 'Info.plist')
      if (!existsSync(plist)) continue
      return execFileSync('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', plist], {
        encoding: 'utf8'
      }).trim()
    }
  }
  throw new Error(`No packaged .app under ${distDir}/mac*`)
}

function main() {
  const i = process.argv.indexOf('--dist')
  const distDir = i === -1 ? null : process.argv[i + 1]
  if (!distDir) throw new Error('Usage: stamp-min-system-version.mjs --dist <dir>')
  const manifest = join(distDir, 'latest-mac.yml')
  if (!existsSync(manifest)) throw new Error(`No ${manifest}`)

  const macos = readMinimumMacos(distDir)
  const darwin = darwinVersionForMacos(macos)
  writeFileSync(manifest, stampMinimumSystemVersion(readFileSync(manifest, 'utf8'), darwin))
  console.log(`latest-mac.yml: minimumSystemVersion ${darwin} (macOS ${macos})`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
