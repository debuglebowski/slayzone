#!/usr/bin/env node
// Build a cross-run failure-identity table from an e2e-campaign.sh output root.
//
//   node e2e-aggregate.mjs ~/.slayzone-e2e-campaign/aged [...more roots]
//
// A per-run pass/fail count cannot distinguish "one test failed five times"
// from "five different tests failed once", and those have opposite
// dispositions. Only aggregation across runs, keyed by test identity, tells
// them apart — that distinction is what the original diagnosis turned on, and
// it is invisible unless somebody joins the runs together.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('usage: node e2e-aggregate.mjs <campaign-dir> [...]')
  process.exit(1)
}

/** Walk Playwright's nested suite tree, yielding one row per test result. */
function* walk(node, file = '', trail = []) {
  const nextFile = node.file ?? file
  const nextTrail = node.title && node.title !== nextFile ? [...trail, node.title] : trail

  for (const spec of node.specs ?? []) {
    for (const test of spec.tests ?? []) {
      // `results` has one entry per attempt; retries are 0 here, so take the last.
      const result = test.results?.[test.results.length - 1]
      yield {
        file: spec.file ?? nextFile,
        title: [...nextTrail, spec.title].filter(Boolean).join(' › '),
        status: result?.status ?? test.status ?? 'unknown',
        expected: test.expectedStatus ?? 'passed',
        duration: result?.duration ?? 0,
        error: result?.error?.message ?? result?.errors?.[0]?.message ?? ''
      }
    }
  }
  for (const child of node.suites ?? []) yield* walk(child, nextFile, nextTrail)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const runs = []

for (const root of roots) {
  if (!existsSync(root)) {
    console.error(`skip: ${root} does not exist`)
    continue
  }
  const label = root.replace(/\/$/, '').split('/').pop()
  const runDirs = readdirSync(root)
    .filter((d) => d.startsWith('run-'))
    .filter((d) => statSync(join(root, d)).isDirectory())
    .sort()

  for (const dir of runDirs) {
    const runPath = join(root, dir)
    const summary = readJson(join(runPath, 'summary.json')) ?? {}
    const before = readJson(join(runPath, 'covariates-before.json')) ?? {}
    const after = readJson(join(runPath, 'covariates-after.json')) ?? {}

    const tests = []
    for (const f of readdirSync(runPath).filter(
      (f) => f.startsWith('report-') && f.endsWith('.json')
    )) {
      const report = readJson(join(runPath, f))
      if (!report) continue
      for (const suite of report.suites ?? []) tests.push(...walk(suite))
    }

    const failures = tests.filter((t) => t.status !== 'passed' && t.status !== 'skipped')

    runs.push({
      id: `${label}/${dir}`,
      label,
      elapsed: summary.elapsed_s ?? null,
      fail: summary.fail,
      gitSha: summary.git_sha ?? '?',
      dirty: summary.git_dirty,
      specSha: summary.spec_sha ?? '?',
      total: tests.length,
      failures,
      // CPU-seconds the co-resident app burned DURING this run. The direct
      // measure of stolen throughput; RSS alone is a GC sawtooth and a single
      // sample of it swings ~500 MB for reasons unrelated to leak growth.
      appCpuDelta:
        before.app_cpu_s != null && after.app_cpu_s != null
          ? after.app_cpu_s - before.app_cpu_s
          : null,
      appAgeH: before.app_age_s != null ? (before.app_age_s / 3600).toFixed(1) : null,
      rendererMb: before.renderer_rss_mb ?? null,
      rendererMbAfter: after.renderer_rss_mb ?? null,
      load1: before.load1 ?? null,
      procs: before.procs ?? null
    })
  }
}

if (runs.length === 0) {
  console.error('no runs found')
  process.exit(1)
}

// ── Per-run table ───────────────────────────────────────────────────────────
const pad = (s, n) => String(s ?? '-').padEnd(n)
const padL = (s, n) => String(s ?? '-').padStart(n)

console.log('\n## Runs\n')
console.log(
  pad('run', 16),
  padL('wall', 6),
  padL('fails', 6),
  padL('tests', 6),
  padL('appCPUs', 8),
  padL('cores', 6),
  padL('ageH', 6),
  padL('rendMB', 7),
  padL('load1', 6),
  pad('  spec', 14)
)
console.log('-'.repeat(100))
for (const r of runs) {
  const cores = r.appCpuDelta != null && r.elapsed ? (r.appCpuDelta / r.elapsed).toFixed(2) : null
  console.log(
    pad(r.id, 16),
    padL(r.elapsed != null ? `${r.elapsed}s` : '-', 6),
    padL(r.failures.length, 6),
    padL(r.total, 6),
    padL(r.appCpuDelta, 8),
    padL(cores, 6),
    padL(r.appAgeH, 6),
    padL(r.rendererMb, 7),
    padL(r.load1, 6),
    pad(`  ${r.specSha}${r.dirty ? ' DIRTY' : ''}`, 14)
  )
}

// Spec-tree drift invalidates cross-run comparison; say so loudly.
const specShas = [...new Set(runs.map((r) => r.specSha))]
if (specShas.length > 1) {
  console.log(
    `\n!! SPEC TREE CHANGED MID-CAMPAIGN (${specShas.length} distinct hashes) — runs are not comparable`
  )
}

// ── Failure identity table ──────────────────────────────────────────────────
const byTest = new Map()
for (const r of runs) {
  for (const f of r.failures) {
    const key = `${f.file} › ${f.title}`
    if (!byTest.has(key)) byTest.set(key, { runs: [], errors: new Set(), durations: [] })
    const entry = byTest.get(key)
    entry.runs.push(r.id)
    entry.durations.push(f.duration)
    if (f.error) entry.errors.add(f.error.split('\n')[0].slice(0, 160))
  }
}

console.log(`\n## Failure identity  (${byTest.size} distinct tests across ${runs.length} runs)\n`)
if (byTest.size === 0) {
  console.log('  none — every test passed in every run')
} else {
  const sorted = [...byTest.entries()].sort((a, b) => b[1].runs.length - a[1].runs.length)
  for (const [key, v] of sorted) {
    console.log(`${padL(v.runs.length, 3)}/${runs.length}  ${key}`)
    console.log(`         runs: ${v.runs.join(', ')}`)
    console.log(`         dur:  ${v.durations.map((d) => `${(d / 1000).toFixed(1)}s`).join(', ')}`)
    for (const e of v.errors) console.log(`         err:  ${e}`)
  }
}

// ── Green streak ────────────────────────────────────────────────────────────
let best = 0
let cur = 0
for (const r of runs) {
  if (r.failures.length === 0 && r.fail === 0) {
    cur += 1
    best = Math.max(best, cur)
  } else cur = 0
}
console.log(
  `\n## Green: ${runs.filter((r) => r.failures.length === 0 && r.fail === 0).length}/${runs.length} runs`
)
console.log(`   longest consecutive streak: ${best}`)
console.log(`   current streak (trailing):  ${cur}`)

// ── Covariate correlation ───────────────────────────────────────────────────
const withCov = runs.filter((r) => r.appCpuDelta != null && r.elapsed)
if (withCov.length >= 2) {
  const red = withCov.filter((r) => r.failures.length > 0)
  const green = withCov.filter((r) => r.failures.length === 0)
  const mean = (xs, f) => (xs.length ? xs.reduce((a, b) => a + f(b), 0) / xs.length : null)
  const fmt = (x) => (x == null ? '-' : x.toFixed(1))
  console.log('\n## Covariates: red vs green runs\n')
  console.log(
    pad('', 10),
    padL('n', 4),
    padL('wall', 8),
    padL('appCPUs', 9),
    padL('cores', 7),
    padL('rendMB', 8)
  )
  for (const [name, set] of [
    ['red', red],
    ['green', green]
  ]) {
    console.log(
      pad(name, 10),
      padL(set.length, 4),
      padL(fmt(mean(set, (r) => r.elapsed)), 8),
      padL(fmt(mean(set, (r) => r.appCpuDelta)), 9),
      padL(fmt(mean(set, (r) => r.appCpuDelta / r.elapsed)), 7),
      padL(fmt(mean(set, (r) => r.rendererMb)), 8)
    )
  }
}
console.log('')
