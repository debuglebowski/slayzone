/**
 * Side-car supervisor stop tests against the REAL built hub under a fake app: an app
 * that awaits the bounded stop exits only once its stuck hub is gone, a standalone
 * hub's stop is never cut short by the supervised deadline, and a healthy supervised
 * hub exits on its own, cleanly, when its app stops it.
 *
 * Split from sidecar-server-supervisor.test.ts (the supervisor against a fake
 * side-car) so these real deadlines run on their own worker.
 */
import { afterAll, expect, test } from 'vitest'
import { SUPERVISED_STOP_DEADLINE_MS } from '@slayzone/platform/parent-watch'
import {
  assertStoppedByItsDeadline,
  cleanupTmpDirs,
  delay,
  pidGone,
  startRealHub,
  waitForRun
} from './sidecar-server-supervisor-harness.js'

afterAll(cleanupTmpDirs)

test('quit: an app that awaits the bounded stop exits only once its stuck hub is gone', async () => {
  // How the app quits now: it waits for the supervisor's stop, so the hub is gone
  // BEFORE the app exits. A stuck hub ends itself at its own deadline — the
  // supervisor's SIGKILL waits past it, so it never preempts a stop that could
  // still finish (or force itself out) in time.
  const run = await startRealHub({ parent: 'supervisor', supervised: true, quit: 'await' })
  try {
    await run.holdConnection()
    run.parent.kill('SIGTERM')
    await waitForRun(
      run,
      () => run.parentOutput().includes('[fake-app] quit'),
      15_000,
      'the app never finished its quit'
    )
    expect(run.parentOutput(), `the quit saw the hub gone — app:\n${run.parentOutput()}`).toContain(
      '[fake-app] quit: stopped'
    )
    expect(
      pidGone(run.hubPid),
      `the hub was gone by the time the app quit — log:\n${run.log()}`
    ).toBe(true)
    assertStoppedByItsDeadline(run)
  } finally {
    run.cleanup()
  }
})

test('stop: a standalone hub is never cut short by the supervised stop deadline', async () => {
  // A standalone hub's stop keeps its old meaning: it waits for its clients however
  // long they take (a graceful drain), then exits cleanly. Only a supervised hub
  // bounds it — a server has no app whose quit it could outlive.
  const run = await startRealHub({ parent: 'standalone', supervised: false })
  try {
    await run.holdConnection()
    process.kill(run.hubPid, 'SIGTERM')
    await waitForRun(
      run,
      () => run.log().includes('shutting down (SIGTERM)'),
      10_000,
      'the hub never got the SIGTERM'
    )
    await delay(6_500) // past the supervised deadline (5s)
    expect(pidGone(run.hubPid), `a standalone hub's stop was cut short — log:\n${run.log()}`).toBe(
      false
    )
    expect(run.log(), 'no forced exit').not.toContain('forcing exit')
    run.releaseConnections()
    await waitForRun(run, () => pidGone(run.hubPid), 10_000, 'the drained hub never exited')
    expect(run.exitCode(), `the drained hub exited cleanly — log:\n${run.log()}`).toBe('0')
  } finally {
    run.cleanup()
  }
})

test('stop: the real supervised hub exits on its own, cleanly, when its app stops it', async () => {
  // The bounded stop must not change a healthy stop: a SIGTERMed hub exits by itself
  // (code 0) well inside its own deadline — not by that deadline, nor by a SIGKILL.
  const run = await startRealHub({ parent: 'supervisor', supervised: true, quit: 'await' })
  try {
    const started = Date.now()
    run.parent.kill('SIGTERM')
    await waitForRun(
      run,
      () => run.parentOutput().includes('[fake-app] quit'),
      10_000,
      'the app never finished its quit'
    )
    const elapsed = Date.now() - started
    expect(
      run.exitCode(),
      `the hub exited by itself, cleanly, ${elapsed}ms after the app's SIGTERM — log:\n${run.log()}\napp:\n${run.parentOutput()}`
    ).toBe('0')
    expect(elapsed, `well inside its own deadline (${elapsed}ms)`).toBeLessThan(
      SUPERVISED_STOP_DEADLINE_MS
    )
  } finally {
    run.cleanup()
  }
})
