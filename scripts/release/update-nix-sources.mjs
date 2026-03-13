#!/usr/bin/env node

// Updates nix/sources.json from a release manifest.
// Usage: update-nix-sources.mjs --manifest <path> --output <path>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

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

function findArtifact(artifacts, name) {
  const a = artifacts.find((x) => x.name === name)
  if (!a) throw new Error(`Artifact not found: ${name}`)
  return a
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.manifest || !args.output) {
    throw new Error('Usage: update-nix-sources.mjs --manifest <path> --output <path>')
  }

  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'))
  const { tag, version } = manifest.release
  const { artifacts } = manifest
  const baseUrl = `https://github.com/debuglebowski/slayzone/releases/download/${tag}`

  const linuxAppImage = findArtifact(artifacts, 'SlayZone-x86_64.AppImage')
  const macArm64Zip = findArtifact(artifacts, 'SlayZone-arm64.zip')
  const macX64Zip = findArtifact(artifacts, 'SlayZone-x64.zip')

  const sources = {
    version,
    tag,
    'x86_64-linux': {
      url: `${baseUrl}/${linuxAppImage.name}`,
      sha256: linuxAppImage.sha256
    },
    'aarch64-darwin': {
      url: `${baseUrl}/${macArm64Zip.name}`,
      sha256: macArm64Zip.sha256
    },
    'x86_64-darwin': {
      url: `${baseUrl}/${macX64Zip.name}`,
      sha256: macX64Zip.sha256
    }
  }

  mkdirSync(path.dirname(args.output), { recursive: true })
  writeFileSync(args.output, JSON.stringify(sources, null, 2) + '\n')
}

main()
