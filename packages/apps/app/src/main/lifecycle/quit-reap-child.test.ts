/**
 * reapChildForQuit — the bounded reap of a supervised child (the local hub, the
 * local computer) during an app quit.
 *
 * `will-quit` used to fire each child's `stop()` and forget it: Electron main then
 * exited before the supervisor's SIGTERM→SIGKILL escalation could land, so a hub or
 * computer that did not exit on SIGTERM was orphaned (ppid 1) — a computer with
 * every agent pty still under it, a hub holding the port and database the next
 * app's hub needs. The quit now waits for the reap — but never past a deadline.
 *
 * Run with: npx tsx packages/apps/app/src/main/lifecycle/quit-reap-child.test.ts
 */
import {
  SUPERVISED_STOP_DEADLINE_MS,
  SUPERVISED_STOP_SIGKILL_GRACE_MS
} from '@slayzone/platform/parent-watch'
import { expect, test } from '../../../../../shared/test-utils/ipc-harness.js'
import { QUIT_CHILD_REAP_MS, reapChildForQuit } from './quit-reap-child'

console.log('\nreapChildForQuit')

test('waits for the child to be reaped', async () => {
  let reaped = false
  const result = await reapChildForQuit({
    stop: async () => {
      await new Promise((r) => setTimeout(r, 30))
      reaped = true
    },
    timeoutMs: 1000
  })
  expect(result).toBe('stopped')
  expect(reaped).toBe(true)
})

test('a quit with no such child has nothing to wait for', async () => {
  const result = await reapChildForQuit({ stop: null, timeoutMs: 1000 })
  expect(result).toBe('none')
})

test('a hung stop cannot block the quit past the deadline', async () => {
  const started = Date.now()
  const result = await reapChildForQuit({
    stop: () => new Promise<void>(() => {}),
    timeoutMs: 50
  })
  expect(result).toBe('timed-out')
  expect(Date.now() - started < 500).toBe(true)
})

test('a failing stop still lets the quit proceed, and says so', async () => {
  const result = await reapChildForQuit({
    stop: async () => {
      throw new Error('kill EPERM')
    },
    timeoutMs: 1000
  })
  expect(result).toBe('failed')
})

test('a synchronously throwing stop still lets the quit proceed', async () => {
  const result = await reapChildForQuit({
    stop: () => {
      throw new Error('boom')
    },
    timeoutMs: 1000
  })
  expect(result).toBe('failed')
})

test('the deadline timer does not outlive a prompt stop', async () => {
  // A stray 5s timer would hold the quitting process's loop open for nothing.
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  await reapChildForQuit({ stop: async () => {}, timeoutMs: 60_000 })
  const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  expect(after <= before).toBe(true)
})

test('the quit waits past the SIGKILL, which waits past the child’s own stop deadline', () => {
  // A graceful stop is never cut shorter than the child's own deadline, and the quit
  // never gives up on a child its supervisor is about to SIGKILL.
  expect(SUPERVISED_STOP_SIGKILL_GRACE_MS > SUPERVISED_STOP_DEADLINE_MS).toBe(true)
  expect(QUIT_CHILD_REAP_MS > SUPERVISED_STOP_SIGKILL_GRACE_MS).toBe(true)
})
