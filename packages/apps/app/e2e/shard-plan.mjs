#!/usr/bin/env node
// Duration-balanced, DETERMINISTIC split of the e2e suite into N processes.
//
//   node e2e/shard-plan.mjs plan <n> <groupDir>...   one line per shard: its spec paths
//   node e2e/shard-plan.mjs record <report.json>...  merge measured per-file ms into
//                                                    e2e/spec-durations.json
//
// The split spans every group dir it is given, not one group at a time: with one
// process per directory the slowest DIRECTORY set the wall clock (browser 353s while
// web-shell finished at 79s), however the rest balanced.
//
// Why not Playwright's own `--shard`: it balances by TEST COUNT, and here a file's
// cost is dominated by its per-file `resetApp` and app/hub launches, not its tests —
// measured on core it put 49 files in one shard and 24 in the other.
//
// Why not dynamic scheduling (`--workers=N`): which files share an Electron app then
// changes run to run, so order-dependent failures rotate identity. Here the same
// spec set + weights always yields the same shards.
//
// A spec absent from spec-durations.json (new file) gets the median weight, so it
// is always scheduled — never silently dropped. Re-record after big spec changes.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.dirname(here)
const durationsPath = path.join(here, 'spec-durations.json')

function readDurations() {
  try {
    return JSON.parse(fs.readFileSync(durationsPath, 'utf8'))
  } catch {
    return {}
  }
}

function plan(n, groupDirs) {
  const files = groupDirs
    .flatMap((dir) => {
      const rel = dir.replace(/\/+$/, '')
      return fs
        .readdirSync(path.join(appDir, rel))
        .filter((f) => f.endsWith('.spec.ts'))
        .map((f) => `${rel}/${f}`)
    })
    .sort()
  const durations = readDurations()
  const known = files.map((f) => durations[f]).filter((v) => typeof v === 'number')
  known.sort((a, b) => a - b)
  const median = known.length ? known[Math.floor(known.length / 2)] : 1
  const weight = (f) => (typeof durations[f] === 'number' ? durations[f] : median)

  // Longest-processing-time first: heaviest file onto the lightest shard. Ties
  // break by path and by shard index, so the result is a pure function of input.
  const shards = Array.from({ length: n }, () => ({ total: 0, files: [] }))
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
  for (const f of ordered) {
    let best = 0
    for (let i = 1; i < n; i++) if (shards[i].total < shards[best].total) best = i
    shards[best].files.push(f)
    shards[best].total += weight(f)
  }
  for (const s of shards) console.log(s.files.sort().join(' '))
}

// A file's cost = from its first test's start to the next file's first test's
// start within the same serial process — this includes beforeAll/resetApp and
// teardown, which the per-test `duration` field does not.
function record(reports) {
  const durations = readDurations()
  for (const reportPath of reports) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    const starts = new Map()
    const ends = new Map()
    const walk = (suite, file) => {
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests) {
          for (const r of t.results) {
            const s = Date.parse(r.startTime)
            const e = s + r.duration
            if (!starts.has(file) || s < starts.get(file)) starts.set(file, s)
            if (!ends.has(file) || e > ends.get(file)) ends.set(file, e)
          }
        }
      }
      for (const child of suite.suites ?? []) walk(child, file)
    }
    for (const suite of report.suites) walk(suite, `e2e/${suite.file}`)
    const order = [...starts.entries()].sort((a, b) => a[1] - b[1])
    order.forEach(([file, start], i) => {
      const next = order[i + 1]?.[1] ?? ends.get(file)
      durations[file] = Math.max(1, Math.round(next - start))
    })
  }
  // Drop weights of deleted/renamed specs so the file only describes the live suite
  // (a stale entry would otherwise skew the median new files are scheduled with).
  const sorted = Object.fromEntries(
    Object.entries(durations)
      .filter(([file]) => fs.existsSync(path.join(appDir, file)))
      .sort(([a], [b]) => a.localeCompare(b))
  )
  fs.writeFileSync(durationsPath, JSON.stringify(sorted, null, 2) + '\n')
  console.log(
    `recorded ${Object.keys(sorted).length} spec durations → ${path.relative(appDir, durationsPath)}`
  )
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'plan' && rest.length >= 2 && Number(rest[0]) >= 1) plan(Number(rest[0]), rest.slice(1))
else if (cmd === 'record' && rest.length > 0) record(rest)
else {
  console.error('usage: shard-plan.mjs plan <n> <groupDir>... | record <report.json>...')
  process.exit(2)
}
