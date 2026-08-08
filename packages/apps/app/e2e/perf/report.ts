#!/usr/bin/env tsx
/**
 * Perf report generator. Reads a run directory written by harness.profileScenario
 * and emits a human-readable markdown summary alongside the raw JSON.
 *
 * Usage:
 *   pnpm tsx packages/apps/app/e2e/perf/report.ts working-notes/performance/run-<ts>
 */

import fs from 'fs'
import path from 'path'
import type { ScenarioResult, IterationResult, IpcCallSummary } from './types'

function loadResults(runDir: string): ScenarioResult[] {
  const files = fs.readdirSync(runDir).filter((f) => f.endsWith('.json'))
  return files
    .map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8')) as ScenarioResult)
    .filter((r) => r && Array.isArray(r.runs))
}

function aggregateProfilerCommits(
  runs: IterationResult[]
): Array<{ id: string; phase: string; count: number; totalActual: number; maxActual: number }> {
  const map = new Map<
    string,
    { id: string; phase: string; count: number; totalActual: number; maxActual: number }
  >()
  for (const run of runs) {
    for (const commit of run.profilerCommits) {
      const key = `${commit.id}::${commit.phase}`
      const existing = map.get(key) ?? {
        id: commit.id,
        phase: commit.phase,
        count: 0,
        totalActual: 0,
        maxActual: 0
      }
      existing.count += 1
      existing.totalActual += commit.actualDuration
      if (commit.actualDuration > existing.maxActual) existing.maxActual = commit.actualDuration
      map.set(key, existing)
    }
  }
  return Array.from(map.values()).sort((a, b) => b.totalActual - a.totalActual)
}

function aggregateIpc(runs: IterationResult[]): IpcCallSummary[] {
  const map = new Map<string, IpcCallSummary>()
  for (const run of runs) {
    for (const call of run.ipcCalls) {
      const existing = map.get(call.channel) ?? {
        channel: call.channel,
        count: 0,
        totalMs: 0,
        maxMs: 0
      }
      existing.count += call.count
      existing.totalMs += call.totalMs
      if (call.maxMs > existing.maxMs) existing.maxMs = call.maxMs
      map.set(call.channel, existing)
    }
  }
  return Array.from(map.values()).sort((a, b) => b.totalMs - a.totalMs)
}

function aggregateLongTasks(runs: IterationResult[]): {
  count: number
  totalMs: number
  maxMs: number
} {
  let count = 0
  let totalMs = 0
  let maxMs = 0
  for (const run of runs) {
    for (const lt of run.longTasks) {
      count += 1
      totalMs += lt.duration
      if (lt.duration > maxMs) maxMs = lt.duration
    }
  }
  return { count, totalMs, maxMs }
}

function fmtMs(n: number): string {
  return `${Math.round(n).toString().padStart(4, ' ')}ms`
}

function renderScenario(result: ScenarioResult): string {
  const lines: string[] = []
  lines.push(`## ${result.name}`)
  lines.push('')
  lines.push(`> ${result.description}`)
  lines.push('')
  lines.push(`- iterations: ${result.iterations} (warmup dropped: ${result.warmupDropped})`)
  lines.push(
    `- wall time: p50=**${fmtMs(result.summary.wallP50).trim()}** p95=**${fmtMs(result.summary.wallP95).trim()}** max=${fmtMs(result.summary.wallMax).trim()}`
  )
  lines.push(`- profiler actual duration p95: ${result.summary.profilerActualP95.toFixed(1)}ms`)
  lines.push(`- long task total p95: ${fmtMs(result.summary.longTaskP95).trim()}`)
  lines.push(`- IPC calls per iteration p50: ${result.summary.ipcCountP50}`)
  lines.push('')

  // Per-iteration table
  lines.push('| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |')
  lines.push('|------|------|---------:|-----------------:|---------:|---------:|')
  for (const run of result.runs) {
    const profilerActual = run.profilerCommits.reduce((s, c) => s + c.actualDuration, 0)
    lines.push(
      `| ${run.index} | ${run.wallMs}ms | ${run.longTaskTotalMs}ms | ${profilerActual.toFixed(1)}ms | ${run.ipcTotal.count} | ${run.heapAfterMB - run.heapBeforeMB} |`
    )
  }
  lines.push('')

  // React Profiler hotspots
  const profilerHot = aggregateProfilerCommits(result.runs).slice(0, 10)
  if (profilerHot.length > 0) {
    lines.push('### Top React commits (by Σ actualDuration)')
    lines.push('')
    lines.push('| component (id) | phase | commits | Σ actual | max |')
    lines.push('|---|---|---:|---:|---:|')
    for (const c of profilerHot) {
      lines.push(
        `| ${c.id} | ${c.phase} | ${c.count} | ${c.totalActual.toFixed(1)}ms | ${c.maxActual.toFixed(1)}ms |`
      )
    }
    lines.push('')
  } else {
    lines.push('_No React Profiler commits captured. Was the app built with `SLAYZONE_PROFILE=1`?_')
    lines.push('')
  }

  // Long tasks
  const longTasks = aggregateLongTasks(result.runs)
  lines.push('### Long tasks')
  lines.push('')
  lines.push(`- count: ${longTasks.count}`)
  lines.push(`- total: ${longTasks.totalMs}ms`)
  lines.push(`- max single: ${longTasks.maxMs}ms`)
  lines.push('')

  // IPC top
  const ipcTop = aggregateIpc(result.runs).slice(0, 10)
  if (ipcTop.length > 0) {
    lines.push('### Top IPC channels (by Σ time)')
    lines.push('')
    lines.push('| channel | calls | Σ time | max |')
    lines.push('|---|---:|---:|---:|')
    for (const c of ipcTop) {
      lines.push(`| ${c.channel} | ${c.count} | ${c.totalMs}ms | ${c.maxMs}ms |`)
    }
    lines.push('')
  }

  // CPU profiles
  const profiles = result.runs
    .filter((r) => r.cpuProfilePath)
    .map((r) => r.cpuProfilePath as string)
  if (profiles.length > 0) {
    lines.push('### CPU profiles')
    lines.push('')
    lines.push('Open in Chrome DevTools → Performance → Load profile:')
    for (const p of profiles) lines.push(`- \`${p}\``)
    lines.push('')
  }

  return lines.join('\n')
}

function renderReport(runDir: string, results: ScenarioResult[]): string {
  const lines: string[] = []
  lines.push(`# SlayZone perf run`)
  lines.push('')
  lines.push(`- run dir: \`${runDir}\``)
  lines.push(`- scenarios: ${results.length}`)
  lines.push(`- generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(renderScenario(r))
    lines.push('---')
    lines.push('')
  }
  return lines.join('\n')
}

function main() {
  const runDir = process.argv[2]
  if (!runDir) {
    console.error('Usage: tsx report.ts <run-dir>')
    process.exit(1)
  }
  const abs = path.resolve(runDir)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error(`Not a directory: ${abs}`)
    process.exit(1)
  }
  const results = loadResults(abs)
  if (results.length === 0) {
    console.error(`No scenario JSONs found in ${abs}`)
    process.exit(1)
  }
  const md = renderReport(abs, results)
  const out = path.join(abs, 'report.md')
  fs.writeFileSync(out, md)
  console.log(`Wrote ${out}`)
}

main()
