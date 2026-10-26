/**
 * stopLocalComputerForQuit — the bounded local-computer reap of an app quit.
 *
 * `will-quit` used to fire the computer's `stop()` and forget it: Electron main
 * then exited before the supervisor's SIGTERM→SIGKILL escalation could land, so a
 * computer that did not exit on SIGTERM was orphaned (ppid 1) with every agent pty
 * still under it. The quit now waits for the reap — but never past a deadline.
 *
 * Run with: npx tsx packages/apps/app/src/main/lifecycle/quit-local-computer.test.ts
 */
import { expect, test } from '../../../../../shared/test-utils/ipc-harness.js'
import { stopLocalComputerForQuit } from './quit-local-computer'

console.log('\nstopLocalComputerForQuit')

test('waits for the computer to be reaped', async () => {
  let reaped = false
  const result = await stopLocalComputerForQuit({
    stop: async () => {
      await new Promise((r) => setTimeout(r, 30))
      reaped = true
    },
    timeoutMs: 1000
  })
  expect(result).toBe('stopped')
  expect(reaped).toBe(true)
})

test('a quit with no local computer has nothing to wait for', async () => {
  const result = await stopLocalComputerForQuit({ stop: null, timeoutMs: 1000 })
  expect(result).toBe('none')
})

test('a hung stop cannot block the quit past the deadline', async () => {
  const started = Date.now()
  const result = await stopLocalComputerForQuit({
    stop: () => new Promise<void>(() => {}),
    timeoutMs: 50
  })
  expect(result).toBe('timed-out')
  expect(Date.now() - started < 500).toBe(true)
})

test('a failing stop still lets the quit proceed, and says so', async () => {
  const result = await stopLocalComputerForQuit({
    stop: async () => {
      throw new Error('kill EPERM')
    },
    timeoutMs: 1000
  })
  expect(result).toBe('failed')
})

test('a synchronously throwing stop still lets the quit proceed', async () => {
  const result = await stopLocalComputerForQuit({
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
  await stopLocalComputerForQuit({ stop: async () => {}, timeoutMs: 60_000 })
  const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  expect(after <= before).toBe(true)
})
