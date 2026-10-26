/**
 * drainDiagnosticsForQuit — the bounded diagnostics tail of an app quit.
 *
 * `will-quit` used to call the async `stopDiagnostics()` without awaiting it and
 * close the diagnostics worker on the next line, so the queue's tail — including
 * the `app.will-quit.complete` canary — raced the close and was lost.
 *
 * Run with: npx tsx packages/apps/app/src/main/lifecycle/quit-diagnostics.test.ts
 */
import { expect, test } from '../../../../../shared/test-utils/ipc-harness.js'
import { drainDiagnosticsForQuit } from './quit-diagnostics'

console.log('\ndrainDiagnosticsForQuit')

test('closes the DB only after the flush has landed', async () => {
  const order: string[] = []
  const result = await drainDiagnosticsForQuit({
    stop: async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push('flushed')
    },
    closeDb: async () => {
      order.push('closed')
    },
    timeoutMs: 1000
  })
  expect(result).toBe('drained')
  expect(order.join(',')).toBe('flushed,closed')
})

test('a failed flush still closes the DB', async () => {
  let closed = false
  const result = await drainDiagnosticsForQuit({
    stop: async () => {
      throw new Error('worker gone')
    },
    closeDb: async () => {
      closed = true
    },
    timeoutMs: 1000
  })
  expect(result).toBe('drained')
  expect(closed).toBe(true)
})

test('a hung flush cannot block the quit past the deadline', async () => {
  const started = Date.now()
  const result = await drainDiagnosticsForQuit({
    stop: () => new Promise<void>(() => {}),
    closeDb: async () => {},
    timeoutMs: 50
  })
  expect(result).toBe('timed-out')
  expect(Date.now() - started < 500).toBe(true)
})

test('a hung close cannot block the quit past the deadline', async () => {
  const result = await drainDiagnosticsForQuit({
    stop: async () => {},
    closeDb: () => new Promise<void>(() => {}),
    timeoutMs: 50
  })
  expect(result).toBe('timed-out')
})
