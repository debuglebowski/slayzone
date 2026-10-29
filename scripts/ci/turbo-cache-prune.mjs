#!/usr/bin/env node
/**
 * CI, before saving Turborepo's local cache (.turbo/cache): drop every entry the current
 * `pnpm typecheck` would not use. Each CI run restores the previous run's cache and saves
 * it again, so without this the saved cache carries every older entry forward and grows
 * with each save; after it, it holds one run's entries (~1 MB).
 *
 *   node scripts/ci/turbo-cache-prune.mjs
 *
 * The current run's task hashes come from `turbo run typecheck --dry=json` (no task runs).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** A cache entry is `<hash>.tar.zst` + `<hash>-meta.json` + `<hash>-manifest.json`. */
const ENTRY_FILE = /^([0-9a-f]+)(?:\.tar\.zst|-meta\.json|-manifest\.json)$/

/** Removes the files of every entry whose hash is not in `keep`; returns how many. */
export function pruneTurboCache(cacheDir, keep) {
  if (!existsSync(cacheDir)) return 0
  let removed = 0
  for (const file of readdirSync(cacheDir)) {
    const hash = ENTRY_FILE.exec(file)?.[1]
    if (hash === undefined || keep.has(hash)) continue
    rmSync(join(cacheDir, file))
    removed++
  }
  return removed
}

/** The task hashes in a `turbo run --dry=json` report. */
export function taskHashes(report) {
  const tasks = JSON.parse(report).tasks ?? []
  if (tasks.length === 0) throw new Error('turbo dry run reported no tasks')
  return new Set(tasks.map((t) => t.hash))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const dry = spawnSync(
    process.execPath,
    [join(root, 'scripts/turbo.mjs'), 'run', 'typecheck', '--dry=json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  if (dry.status !== 0) {
    process.stderr.write(dry.stderr)
    throw new Error(`turbo dry run exited ${dry.status}`)
  }
  const keep = taskHashes(dry.stdout)
  const cacheDir = join(root, '.turbo', 'cache')
  const removed = pruneTurboCache(cacheDir, keep)
  const left = existsSync(cacheDir) ? readdirSync(cacheDir).length : 0
  console.log(
    `turbo-cache-prune: removed ${removed} files, ${left} left (${keep.size} current tasks)`
  )
}
