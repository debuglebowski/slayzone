/**
 * Stale-process selection for the e2e global setup.
 *
 * `global-setup` reaps leftovers from previous interrupted test runs by
 * `pgrep`ing for bundle paths. The bundle paths of a TEST run and of the
 * developer's live `pnpm dev` app are IDENTICAL, so a pattern match alone
 * cannot tell them apart — and matching `runner/dist/bin.cjs` SIGTERM'd the
 * supervised dev app's local runner, which owns every agent pty on the machine.
 * Each agent terminal then showed "Process exited with code 1" at the same
 * instant, once per `pnpm test:e2e` invocation.
 *
 * The discriminator is the Playwright marker in the process ENVIRONMENT
 * (`e2e/fixtures/electron.ts` sets `PLAYWRIGHT=1` on every app it launches, and
 * the sidecar + runner it spawns inherit it). A dev-run process never has it.
 *
 * Selection fails CLOSED: an unreadable environment is not killed. A missed
 * orphan costs a warning; a killed dev runner costs every running agent.
 *
 * Run with:
 *   npx tsx packages/apps/app/e2e/fixtures/stale-processes.test.ts
 */
import { parsePgrepOutput, selectTestRunPids, type StaleCandidate } from './stale-processes.js'

// --- tiny async test harness (matches repo style — no vitest) -------------

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void): void {
  tests.push({ name, fn })
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`)
}

const RUNNER = '/repo/packages/apps/runner/dist/bin.cjs'
/** An environ blob shaped like `ps eww` output. */
const devEnv = `PATH=/usr/bin SLAYZONE_SUPERVISED=1 SHELL=/bin/zsh`
const e2eEnv = `PATH=/usr/bin SLAYZONE_SUPERVISED=1 PLAYWRIGHT=1 SHELL=/bin/zsh`

function reader(map: Record<number, string>): (pid: number) => string {
  return (pid) => {
    const env = map[pid]
    if (env === undefined) throw new Error(`no such process ${pid}`)
    return env
  }
}

// --- tests ----------------------------------------------------------------

test('parses `pgrep -af` output into pid + command', () => {
  const out = `1234 Electron ${RUNNER}\n5678 Electron ${RUNNER}\n`
  assertEq(parsePgrepOutput(out), [
    { pid: 1234, command: `Electron ${RUNNER}` },
    { pid: 5678, command: `Electron ${RUNNER}` }
  ] satisfies StaleCandidate[], 'both lines parsed')
})

test('ignores blank and malformed pgrep lines', () => {
  assertEq(parsePgrepOutput('\n  \nnotapid something\n'), [], 'nothing selected from junk')
})

test('does NOT select a dev-run process — the regression', () => {
  // Same bundle path as a test run; only the environment tells them apart.
  const candidates = parsePgrepOutput(`4242 Electron ${RUNNER}`)
  assertEq(selectTestRunPids(candidates, reader({ 4242: devEnv }), []), [], 'dev runner spared')
})

test('selects a process carrying the Playwright marker', () => {
  const candidates = parsePgrepOutput(`4242 Electron ${RUNNER}\n4243 Electron ${RUNNER}`)
  assertEq(
    selectTestRunPids(candidates, reader({ 4242: devEnv, 4243: e2eEnv }), []),
    [4243],
    'only the e2e leftover is reaped'
  )
})

test('never selects an excluded pid, marker or not', () => {
  const candidates = parsePgrepOutput(`4243 Electron ${RUNNER}`)
  assertEq(
    selectTestRunPids(candidates, reader({ 4243: e2eEnv }), [4243]),
    [],
    'self/parent pid excluded'
  )
})

test('fails closed when the environment cannot be read', () => {
  const candidates = parsePgrepOutput(`9999 Electron ${RUNNER}`)
  assertEq(selectTestRunPids(candidates, reader({}), []), [], 'unreadable env is not killed')
})

test('does not match PLAYWRIGHT as a substring of another variable', () => {
  const candidates = parsePgrepOutput(`4244 Electron ${RUNNER}`)
  const sneaky = `PATH=/usr/bin NOT_PLAYWRIGHT=1 MY_PLAYWRIGHT_DIR=/tmp`
  assertEq(selectTestRunPids(candidates, reader({ 4244: sneaky }), []), [], 'no substring match')
})

// --- runner ---------------------------------------------------------------

let passed = 0
let failed = 0
console.log('\n=== e2e stale-process selection ===\n')
for (const { name, fn } of tests) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    failed++
  }
}
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed > 0 ? 1 : 0
