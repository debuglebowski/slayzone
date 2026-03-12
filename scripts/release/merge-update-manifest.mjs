#!/usr/bin/env node

// Merges two electron-builder auto-update manifests (latest-*.yml).
// These are simple YAML with a top-level `files:` array. When building
// the same platform for multiple architectures in separate CI jobs, each
// job produces its own manifest. This script merges the files arrays
// and writes the result back to --existing.
//
// Usage: merge-update-manifest.mjs --existing <path> --incoming <path>

import { readFileSync, writeFileSync } from 'node:fs'

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

// Minimal parser for electron-builder's latest-*.yml format.
// Structure: top-level key-value pairs + a `files:` array of objects.
function parseManifest(text) {
  const lines = text.split('\n')
  const top = {}
  const files = []
  let inFiles = false
  let current = null

  for (const line of lines) {
    if (line === 'files:') {
      inFiles = true
      continue
    }

    if (inFiles) {
      if (line.startsWith('  - ')) {
        current = {}
        files.push(current)
        const rest = line.slice(4)
        const colonIdx = rest.indexOf(': ')
        if (colonIdx !== -1) {
          current[rest.slice(0, colonIdx)] = rest.slice(colonIdx + 2)
        }
        continue
      }
      if (line.startsWith('    ') && current) {
        const trimmed = line.trim()
        const colonIdx = trimmed.indexOf(': ')
        if (colonIdx !== -1) {
          current[trimmed.slice(0, colonIdx)] = trimmed.slice(colonIdx + 2)
        }
        continue
      }
      inFiles = false
      current = null
    }

    const colonIdx = line.indexOf(': ')
    if (colonIdx !== -1 && !line.startsWith(' ')) {
      top[line.slice(0, colonIdx)] = line.slice(colonIdx + 2)
    }
  }

  return { top, files }
}

function serializeManifest(top, files) {
  let out = `version: ${top.version}\n`
  out += 'files:\n'
  for (const f of files) {
    const entries = Object.entries(f)
    const [firstKey, firstVal] = entries[0]
    out += `  - ${firstKey}: ${firstVal}\n`
    for (let i = 1; i < entries.length; i++) {
      out += `    ${entries[i][0]}: ${entries[i][1]}\n`
    }
  }
  out += `path: ${files[0].url}\n`
  out += `sha512: ${files[0].sha512}\n`
  if (top.releaseDate) {
    out += `releaseDate: ${top.releaseDate}\n`
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.existing || !args.incoming) {
    throw new Error('Usage: merge-update-manifest.mjs --existing <path> --incoming <path>')
  }

  const existing = parseManifest(readFileSync(args.existing, 'utf8'))
  const incoming = parseManifest(readFileSync(args.incoming, 'utf8'))

  const seenUrls = new Set(existing.files.map((f) => f.url))
  for (const f of incoming.files) {
    if (!seenUrls.has(f.url)) {
      existing.files.push(f)
      seenUrls.add(f.url)
    }
  }

  writeFileSync(args.existing, serializeManifest(existing.top, existing.files))
}

main()
