#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const APP_PKG_PATH = 'packages/apps/app/package.json'
const CLI_PKG_PATH = 'packages/apps/cli/package.json'

function usage() {
  return 'Usage: node scripts/release/cut-beta.mjs <patch|minor|major|X.Y.Z>'
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function readVersion(path) {
  return JSON.parse(readFileSync(path, 'utf8')).version
}

function writeVersion(path, version) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.version = version
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
}

function bumpVersion(current, bump) {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) throw new Error(`Cannot parse current version: ${current}`)
  const [, major, minor, patch] = match.map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function nextBetaNumber(baseVersion) {
  // Best-effort refresh so we don't reuse a beta number already pushed.
  // Non-fatal: offline, or local tags that would clobber on fetch (common with
  // multiple remotes), must not abort a purely-local beta cut — fall back to
  // whatever tags we have locally.
  try {
    git(['fetch', '--tags', '--quiet'])
  } catch {
    console.warn('warning: git fetch --tags failed; using local tags only.')
  }
  const tags = git(['tag', '-l', `v${baseVersion}-beta.*`])
    .split('\n')
    .filter(Boolean)
  let max = 0
  for (const tag of tags) {
    const match = tag.match(/-beta\.(\d+)$/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error(usage())
    process.exit(1)
  }

  let baseVersion
  if (['patch', 'minor', 'major'].includes(arg)) {
    const current = readVersion(APP_PKG_PATH)
    baseVersion = bumpVersion(current, arg)
  } else if (/^\d+\.\d+\.\d+$/.test(arg)) {
    baseVersion = arg
  } else {
    console.error(`Invalid argument: ${arg}`)
    console.error(usage())
    process.exit(1)
  }

  const betaNumber = nextBetaNumber(baseVersion)
  const version = `${baseVersion}-beta.${betaNumber}`
  const tag = `v${version}`

  writeVersion(APP_PKG_PATH, version)
  writeVersion(CLI_PKG_PATH, version)

  // Stamp the shared version into every other workspace manifest.
  execFileSync('node', ['scripts/sync-versions.mjs'], { stdio: 'inherit' })

  git(['add', '-A', '--', '*package.json'])
  git(['commit', '-m', `chore(release): ${tag}`])
  git(['tag', tag])

  console.log(`Cut ${tag} (local commit + tag only).`)
  console.log('Push it when ready:')
  console.log(`  git push && git push origin ${tag}`)
}

main()
