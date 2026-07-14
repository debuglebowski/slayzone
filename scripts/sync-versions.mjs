#!/usr/bin/env node
// Sync every workspace package.json version to the canonical @slayzone/app version.
// Source of truth: packages/apps/app/package.json.
//
//   node scripts/sync-versions.mjs           # write: stamp all manifests
//   node scripts/sync-versions.mjs --check   # read-only: exit 1 if any drift

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PKG = 'packages/apps/app/package.json'

// Not a real workspace package — bare { type: module } test fixture.
const SKIP = new Set(['packages/apps/cli/test/package.json'])

function trackedManifests() {
  const out = execFileSync('git', ['ls-files', '*package.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => !p.includes('node_modules') && !SKIP.has(p))
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
}

// Set/insert "version" right after "name" (or first key if no name),
// preserving all other key order. 2-space indent + trailing newline.
function writeVersion(rel, version) {
  const pkg = readJson(rel)
  if (pkg.version === version) return false
  const rebuilt = {}
  let inserted = 'version' in pkg
  for (const [k, v] of Object.entries(pkg)) {
    rebuilt[k] = k === 'version' ? version : v
    if (!inserted && k === 'name') {
      rebuilt.version = version
      inserted = true
    }
  }
  if (!inserted) rebuilt.version = version // no name key: append
  writeFileSync(join(ROOT, rel), `${JSON.stringify(rebuilt, null, 2)}\n`)
  return true
}

function main() {
  const check = process.argv.includes('--check')
  const canonical = readJson(APP_PKG).version
  if (!canonical) {
    console.error(`No version in ${APP_PKG}`)
    process.exit(1)
  }

  const manifests = trackedManifests()

  if (check) {
    const drift = manifests.filter((rel) => readJson(rel).version !== canonical)
    if (drift.length) {
      console.error(`Version drift — canonical @slayzone/app is ${canonical}:`)
      for (const rel of drift) {
        console.error(`  ${rel}: ${readJson(rel).version ?? '(none)'}`)
      }
      console.error('\nRun: node scripts/sync-versions.mjs')
      process.exit(1)
    }
    console.log(`All ${manifests.length} manifests at ${canonical}.`)
    return
  }

  let changed = 0
  for (const rel of manifests) {
    if (writeVersion(rel, canonical)) {
      console.log(`  ${relative('.', rel)} → ${canonical}`)
      changed++
    }
  }
  console.log(
    changed
      ? `Synced ${changed} manifest(s) to ${canonical}.`
      : `Already at ${canonical} — no changes.`,
  )
}

main()
