/**
 * Stale-process selection for the e2e global setup.
 *
 * `global-setup` reaps leftovers from previous interrupted test runs by
 * `pgrep`ing for bundle paths. The bundle paths of a TEST run and of the
 * developer's live `pnpm dev` app are IDENTICAL, so a pattern match alone
 * cannot tell them apart — and matching `computer/dist/bin.cjs` SIGTERM'd the
 * supervised dev app's local computer, which owns every agent pty on the machine.
 * Each agent terminal then showed "Process exited with code 1" at the same
 * instant, once per `pnpm test:e2e` invocation.
 *
 * The discriminator is the Playwright marker in the process ENVIRONMENT
 * (`e2e/fixtures/electron.ts` sets `PLAYWRIGHT=1` on every app it launches, and
 * the sidecar + computer it spawns inherit it). A dev-run process never has it.
 *
 * Selection fails CLOSED: an unreadable environment is not killed. A missed
 * orphan costs a warning; a killed dev computer costs every running agent.
 */
import { expect, test } from 'vitest'
import { parsePgrepOutput, selectTestRunPids, type StaleCandidate } from './stale-processes.js'

const COMPUTER = '/repo/packages/apps/computer/dist/bin.cjs'
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
  const out = `1234 Electron ${COMPUTER}\n5678 Electron ${COMPUTER}\n`
  expect(parsePgrepOutput(out), 'both lines parsed').toEqual([
    { pid: 1234, command: `Electron ${COMPUTER}` },
    { pid: 5678, command: `Electron ${COMPUTER}` }
  ] satisfies StaleCandidate[])
})

test('ignores blank and malformed pgrep lines', () => {
  expect(parsePgrepOutput('\n  \nnotapid something\n'), 'nothing selected from junk').toEqual([])
})

test('does NOT select a dev-run process — the regression', () => {
  // Same bundle path as a test run; only the environment tells them apart.
  const candidates = parsePgrepOutput(`4242 Electron ${COMPUTER}`)
  expect(
    selectTestRunPids(candidates, reader({ 4242: devEnv }), []),
    'dev computer spared'
  ).toEqual([])
})

test('selects a process carrying the Playwright marker', () => {
  const candidates = parsePgrepOutput(`4242 Electron ${COMPUTER}\n4243 Electron ${COMPUTER}`)
  expect(
    selectTestRunPids(candidates, reader({ 4242: devEnv, 4243: e2eEnv }), []),
    'only the e2e leftover is reaped'
  ).toEqual([4243])
})

test('never selects an excluded pid, marker or not', () => {
  const candidates = parsePgrepOutput(`4243 Electron ${COMPUTER}`)
  expect(
    selectTestRunPids(candidates, reader({ 4243: e2eEnv }), [4243]),
    'self/parent pid excluded'
  ).toEqual([])
})

test('fails closed when the environment cannot be read', () => {
  const candidates = parsePgrepOutput(`9999 Electron ${COMPUTER}`)
  expect(selectTestRunPids(candidates, reader({}), []), 'unreadable env is not killed').toEqual([])
})

test('does not match PLAYWRIGHT as a substring of another variable', () => {
  const candidates = parsePgrepOutput(`4244 Electron ${COMPUTER}`)
  const sneaky = `PATH=/usr/bin NOT_PLAYWRIGHT=1 MY_PLAYWRIGHT_DIR=/tmp`
  expect(selectTestRunPids(candidates, reader({ 4244: sneaky }), []), 'no substring match').toEqual(
    []
  )
})

// --- concurrent runs --------------------------------------------------------
// Every e2e invocation runs this reaper. Parallel agents start runs while others
// are mid-test, and a marker match alone SIGTERM'd those LIVE runs' apps: Electron
// quits on SIGTERM, so the other run's main window closed mid-test ("Main window
// LOST … process still running") — the failure rotated across specs per run.

const owned = (owner: number) => `${e2eEnv} SLAYZONE_E2E_OWNER_PID=${owner}`

test('does NOT select a process whose owning run is still alive', () => {
  const candidates = parsePgrepOutput(`4250 Electron ${COMPUTER}`)
  expect(
    selectTestRunPids(candidates, reader({ 4250: owned(777) }), [], (pid) => pid === 777),
    'live run kept'
  ).toEqual([])
})

test('selects a process whose owning run has died', () => {
  const candidates = parsePgrepOutput(`4251 Electron ${COMPUTER}`)
  expect(
    selectTestRunPids(candidates, reader({ 4251: owned(778) }), [], () => false),
    'orphan of a dead run reaped'
  ).toEqual([4251])
})

test('a marker without an owner (pre-owner build) is still reaped', () => {
  const candidates = parsePgrepOutput(`4252 Electron ${COMPUTER}`)
  expect(
    selectTestRunPids(candidates, reader({ 4252: e2eEnv }), [], () => true),
    'legacy orphan'
  ).toEqual([4252])
})
