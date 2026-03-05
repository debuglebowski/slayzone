#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

function sha256(filePath) {
  const hash = createHash('sha256')
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const assetsDir = args['assets-dir']
  const outputPath = args.output
  const checksumsPath = args.checksums
  const tag = args.tag
  const commit = args.commit
  const mode = args.mode
  const channelsJson = args['channels-json']

  if (!assetsDir || !outputPath || !checksumsPath || !tag || !commit || !mode || !channelsJson) {
    throw new Error(
      [
        'Usage: generate-release-manifest.mjs',
        '--assets-dir <dir>',
        '--output <file>',
        '--checksums <file>',
        '--tag <vX.Y.Z>',
        '--commit <sha>',
        '--mode <dry-run|publish>',
        '--channels-json <json>'
      ].join(' ')
    )
  }

  const channels = JSON.parse(channelsJson)
  if (!Array.isArray(channels) || channels.length === 0 || channels.some((c) => typeof c !== 'string' || c.length === 0)) {
    throw new Error('channels-json must be a non-empty JSON string array')
  }

  const assets = readdirSync(assetsDir)
    .filter((entry) => {
      const stats = statSync(path.join(assetsDir, entry))
      return stats.isFile()
    })
    .sort((a, b) => a.localeCompare(b))

  if (assets.length === 0) {
    throw new Error(`No assets found in ${assetsDir}`)
  }

  const artifacts = assets.map((fileName) => {
    const filePath = path.join(assetsDir, fileName)
    const stats = statSync(filePath)
    return {
      name: fileName,
      size: stats.size,
      sha256: sha256(filePath)
    }
  })

  const checksums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n') + '\n'

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    release: {
      tag,
      version: tag.replace(/^v/, ''),
      commit,
      mode,
      channels
    },
    artifacts
  }

  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(checksumsPath, checksums)
}

main()
