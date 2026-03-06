#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const INCLUDED_SUFFIXES = [
  '.appimage',
  '.deb',
  '.dmg',
  '.exe',
  '.msi',
  '.nupkg',
  '.pkg',
  '.rpm',
  '.snap',
  '.yml',
  '.yaml',
  '.zip'
]

const EXCLUDED_BASENAMES = new Set(['builder-debug.yml', 'builder-effective-config.yaml'])
const EXCLUDED_SUFFIXES = ['.blockmap']

// On Windows, electron-builder outputs both installer .exe files and internal
// helper binaries (winpty-agent.exe, etc.) that appear across arch subdirs.
// Only include .exe files that look like installers (contain "setup" or "Setup").
function isInstallerExe(baseName) {
  const lower = baseName.toLowerCase()
  if (!lower.endsWith('.exe')) return true // not an exe, defer to other checks
  return lower.includes('setup')
}

function parseArgs(argv) {
  const args = {}

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]
    if (!current.startsWith('--')) continue
    const key = current.slice(2)
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    args[key] = value
    i += 1
  }

  return args
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      walkFiles(fullPath, out)
      continue
    }

    if (stats.isFile()) {
      out.push(fullPath)
    }
  }

  return out
}

function isIncluded(filePath) {
  const baseName = path.basename(filePath)
  const lowerBase = baseName.toLowerCase()

  if (EXCLUDED_BASENAMES.has(lowerBase)) {
    return false
  }

  if (EXCLUDED_SUFFIXES.some((suffix) => lowerBase.endsWith(suffix))) {
    return false
  }

  if (!INCLUDED_SUFFIXES.some((suffix) => lowerBase.endsWith(suffix))) {
    return false
  }

  return isInstallerExe(baseName)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const inputDir = args.input
  const outputDir = args.output

  if (!inputDir || !outputDir) {
    throw new Error('Usage: collect-release-assets.mjs --input <dir> --output <dir>')
  }

  if (!existsSync(inputDir)) {
    throw new Error(`Input directory not found: ${inputDir}`)
  }

  mkdirSync(outputDir, { recursive: true })

  const copied = []
  for (const filePath of walkFiles(inputDir)) {
    if (!isIncluded(filePath)) continue

    const baseName = path.basename(filePath)
    const destination = path.join(outputDir, baseName)

    if (existsSync(destination)) {
      // Windows builds with --x64 --arm64 produce arch-specific installers
      // but identical update manifests (app-update.yml). Skip exact duplicates.
      const existingSize = statSync(destination).size
      const newSize = statSync(filePath).size
      if (existingSize === newSize) {
        continue
      }
      throw new Error(`Duplicate output filename detected with different content: ${baseName}`)
    }

    cpSync(filePath, destination)
    copied.push(baseName)
  }

  if (copied.length === 0) {
    throw new Error(`No release assets found in ${inputDir}`)
  }

  copied.sort((a, b) => a.localeCompare(b))
  for (const name of copied) {
    console.log(name)
  }
}

main()
