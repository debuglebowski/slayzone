#!/usr/bin/env node
/**
 * Fail on security advisories nobody has looked at yet.
 *
 *   node scripts/ci/audit-check.mjs        (pnpm audit:check)
 *
 * `pnpm audit --prod` alone is useless as a gate: most of its hits need a feature,
 * config or input this app doesn't have, so it is always red and stops being read.
 * Every advisory therefore needs a decision. Fix it (bump), or record why it doesn't
 * apply in audit-allowlist.json, with a review date and an expiry. This script fails
 * when an advisory has no decision, or its decision has expired, so a red run always
 * means "look at this".
 *
 * Production dependencies only: dev tooling runs on our own machines and CI with our
 * own inputs, and Renovate keeps it current.
 *
 * Allowlist entries whose advisories are no longer reported are printed as stale
 * (remove them), but don't fail the run: a fix landing must never turn CI red.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWLIST_PATH = join(dirname(fileURLToPath(import.meta.url)), 'audit-allowlist.json')

function runAudit() {
  // pnpm audit exits non-zero whenever it finds anything; the JSON is what matters.
  // The registry's audit endpoint is occasionally flaky, so retry once.
  for (let attempt = 1; ; attempt++) {
    let stdout
    try {
      stdout = execFileSync('pnpm', ['audit', '--prod', '--json'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      stdout = err.stdout
    }
    try {
      const report = JSON.parse(stdout)
      if (report.advisories) return report
      throw new Error(report.error?.message ?? 'no advisories field in pnpm audit output')
    } catch (err) {
      if (attempt >= 2) throw new Error(`pnpm audit failed: ${err.message}`)
    }
  }
}

// A decision is about one advisory in one package: the same GHSA can hit two packages
// (lodash and lodash-es) that reach us by different routes, for different reasons.
const keyOf = (id, module) => `${id} ${module}`

function loadAllowlist(today) {
  const { entries } = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  const decisions = new Map()
  for (const entry of entries) {
    for (const id of entry.advisories) {
      for (const module of entry.packages) {
        const key = keyOf(id, module)
        if (decisions.has(key))
          throw new Error(`${id} in ${module} is decided twice in audit-allowlist.json`)
        decisions.set(key, { ...entry, expired: entry.expires < today })
      }
    }
  }
  return { entries, decisions }
}

function summarize(advisories) {
  // One row per advisory and package: the same advisory can be reported once per vulnerable range.
  const rows = new Map()
  for (const adv of Object.values(advisories)) {
    const id = adv.github_advisory_id
    const key = keyOf(id, adv.module_name)
    const row = rows.get(key) ?? {
      key,
      id,
      module: adv.module_name,
      severity: adv.severity,
      title: adv.title,
      patched: adv.patched_versions,
      paths: new Set()
    }
    for (const finding of adv.findings ?? []) for (const path of finding.paths) row.paths.add(path)
    rows.set(key, row)
  }
  return [...rows.values()]
}

const today = new Date().toISOString().slice(0, 10)
const { entries, decisions } = loadAllowlist(today)
const reported = summarize(runAudit().advisories)

const undecided = reported.filter((a) => !decisions.has(a.key))
const expired = reported.filter((a) => decisions.get(a.key)?.expired)
const reportedKeys = new Set(reported.map((a) => a.key))
const stale = entries.flatMap((entry) =>
  entry.advisories.filter(
    (id) => !entry.packages.some((module) => reportedKeys.has(keyOf(id, module)))
  )
)

const lines = []
const table = (rows, note) => {
  lines.push('| Advisory | Package | Severity | Fixed in | Note |', '|---|---|---|---|---|')
  for (const a of rows) {
    const path = [...a.paths][0]?.replaceAll('>', ' › ') ?? ''
    lines.push(
      `| [${a.id}](https://github.com/advisories/${a.id}) ${a.title} | \`${a.module}\` (via ${path}) | ${a.severity} | ${a.patched} | ${note(a)} |`
    )
  }
  lines.push('')
}

lines.push(
  `## pnpm audit --prod: ${reported.length} advisories, ${reported.length - undecided.length - expired.length} with a current decision`,
  ''
)
if (undecided.length) {
  lines.push(
    `### ${undecided.length} new: fix, or add to scripts/ci/audit-allowlist.json with a reason`,
    ''
  )
  table(undecided, () => 'no decision yet')
}
if (expired.length) {
  lines.push(`### ${expired.length} with an expired decision: re-review`, '')
  table(expired, (a) => `expired ${decisions.get(a.key).expires}: ${decisions.get(a.key).reason}`)
}
if (stale.length) {
  lines.push(
    `### ${stale.length} allowlisted but no longer reported: remove from the allowlist`,
    '',
    ...stale.map((id) => `- ${id}`),
    ''
  )
}

const markdown = lines.join('\n')
console.log(markdown)
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
process.exit(undecided.length || expired.length ? 1 : 0)
