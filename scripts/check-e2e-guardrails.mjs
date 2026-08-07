#!/usr/bin/env node
/**
 * Guard the three e2e failure classes that a flake investigation traced to their
 * root, each of which is invisible in review and expensive in the suite.
 *
 * 1. DROPPED PROMISE — a block-bodied `page.evaluate` whose tRPC call is not
 *    returned. `evaluate` resolves when the block returns `undefined`, i.e. BEFORE
 *    the call is dispatched, so the test races an unsynchronised write. Found
 *    exactly one instance (`runCommand`) sitting under 34 call sites.
 *
 * 2. RETRY BUDGET >= TEST BUDGET — a `toPass`/`poll` whose timeout is at least the
 *    enclosing test timeout can never report its own failure: Playwright kills the
 *    test first and blames whatever line was executing. `showProjectBoard` used
 *    `toPass({ timeout: 30_000 })` inside a 30_000ms test, and its failures were
 *    reported as "element(s) not found, 4000ms" — the inner assertion, not the
 *    real budget. Unsatisfiable by construction.
 *
 * 3. WALL-CLOCK BUDGET IN THE PARALLEL SUITE — `expect(<ms>).toBeLessThan(n)`
 *    measures the machine, not the product, when six Electron apps share the
 *    cores. Latency assertions belong in the serial perf phase.
 *
 * Usage: node scripts/check-e2e-guardrails.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const E2E_ROOT = 'packages/apps/app/e2e'
/** Latency budgets are legitimate here — it runs alone. */
const PERF_DIRS = [path.join(E2E_ROOT, 'perf')]
/** Must match `timeout` in playwright.config.ts. */
const TEST_TIMEOUT_MS = 30_000

const violations = []

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = walk(E2E_ROOT)

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const inPerf = PERF_DIRS.some((d) => file.startsWith(d))

  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`

    // (1) A statement-position tRPC call whose enclosing arrow has a BLOCK body:
    // the previous non-empty line ends with `{`, and this line neither returns
    // nor awaits nor assigns. Multi-line `return (\n  window...` is unaffected.
    if (/^\s*window[.\s]*$|^\s*window\.getTrpcVanillaClient\(\)/.test(line)) {
      if (!/return|await|=[^=>]|\.then/.test(line)) {
        let j = i - 1
        while (j >= 0 && !lines[j].trim()) j--
        if (j >= 0 && /\{\s*$/.test(lines[j])) {
          violations.push(
            `${at}\n    dropped tRPC promise in a block-bodied evaluate — add \`return\`\n    ${line.trim()}`
          )
        }
      }
    }

    // (2) A retry wrapper budget that meets or exceeds the test budget.
    const budget = line.match(/\.(?:toPass|poll)\s*\(?[^)]*timeout:\s*([0-9_]+)/)
    if (budget) {
      const ms = Number(budget[1].replace(/_/g, ''))
      if (ms >= TEST_TIMEOUT_MS) {
        violations.push(
          `${at}\n    retry budget ${ms}ms >= test timeout ${TEST_TIMEOUT_MS}ms — it can never report its own failure\n    ${line.trim()}`
        )
      }
    }
    // Same check for a default parameter feeding one (e.g. `timeout = 30_000`).
    const dflt = line.match(/timeout\s*=\s*([0-9_]+)/)
    if (dflt) {
      const ms = Number(dflt[1].replace(/_/g, ''))
      if (ms >= TEST_TIMEOUT_MS) {
        violations.push(
          `${at}\n    default retry budget ${ms}ms >= test timeout ${TEST_TIMEOUT_MS}ms\n    ${line.trim()}`
        )
      }
    }

    // (3) A wall-clock assertion outside the serial perf phase. Keyed on a
    // duration-shaped identifier so DOM/geometry assertions are not flagged.
    if (!inPerf && /toBeLessThan\(/.test(line)) {
      if (/\b\w*(Ms|Duration|Latency|elapsed|duration)\w*\b/.test(line)) {
        violations.push(
          `${at}\n    wall-clock budget in the parallel suite — move it to e2e/perf (runs alone)\n    ${line.trim()}`
        )
      }
    }
  })
}

if (violations.length) {
  console.error(`\n✖ e2e guardrails: ${violations.length} violation(s)\n`)
  for (const v of violations) console.error(`  ${v}\n`)
  process.exit(1)
}
console.log(`✔ e2e guardrails: ${files.length} files clean`)
