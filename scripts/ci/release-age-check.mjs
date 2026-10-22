#!/usr/bin/env node
/**
 * Fail when the lockfile gains a package version published less than
 * `minimumReleaseAge` ago (pnpm-workspace.yaml, in minutes — the one source of truth).
 *
 *   node scripts/ci/release-age-check.mjs [base-ref]     (default: origin/main)
 *
 * pnpm enforces `minimumReleaseAge` only when it resolves a version. Versions already
 * in the lockfile are installed as-is, even with `--frozen-lockfile`, so a young
 * version that got in before the setting (or through a hand-edited lockfile) would
 * never be caught. This checks every version the lockfile adds relative to base-ref.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const base = process.argv[2] ?? 'origin/main'

const minutes = Number(
  readFileSync('pnpm-workspace.yaml', 'utf8').match(/^minimumReleaseAge:\s*(\d+)\s*$/m)?.[1]
)
if (!minutes) throw new Error('pnpm-workspace.yaml has no minimumReleaseAge')

/** `name@version` keys of the lockfile's `packages:` section (registry packages only). */
function lockedVersions(text) {
  const section = text.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
  const out = new Set()
  for (const [, key] of section.matchAll(/^ {2}'?((?:@[^/\s]+\/)?[^@\s']+@\d[^:'\s(]*)'?:/gm))
    out.add(key)
  return out
}

const before = lockedVersions(
  execFileSync('git', ['show', `${base}:pnpm-lock.yaml`], { encoding: 'utf8', maxBuffer: 1 << 28 })
)
const added = [...lockedVersions(readFileSync('pnpm-lock.yaml', 'utf8'))].filter(
  (k) => !before.has(k)
)

const cutoff = Date.now() - minutes * 60_000
const publishTimes = new Map()
async function fetchTimes(name) {
  // Full packuments can be many MB; the registry occasionally drops the socket.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`)
      if (!res.ok) throw new Error(`registry ${res.status} for ${name}`)
      return (await res.json()).time ?? {}
    } catch (err) {
      if (attempt >= 4) throw err
      await new Promise((r) => setTimeout(r, attempt * 1000))
    }
  }
}
function publishedAt(name) {
  if (!publishTimes.has(name)) publishTimes.set(name, fetchTimes(name))
  return publishTimes.get(name)
}

const young = []
const queue = [...added]
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      const at = key.lastIndexOf('@')
      const [name, version] = [key.slice(0, at), key.slice(at + 1)]
      const time = (await publishedAt(name))[version]
      if (!time) young.push({ key, published: 'unknown' })
      else if (Date.parse(time) > cutoff) young.push({ key, published: time.slice(0, 10) })
    }
  })
)

const days = minutes / 1440
console.log(
  `${added.length} package versions added to pnpm-lock.yaml since ${base}; minimum age ${days} days`
)
for (const { key, published } of young.sort((a, b) => a.key.localeCompare(b.key))) {
  console.log(`  too young: ${key} (published ${published})`)
}
process.exit(young.length ? 1 : 0)
