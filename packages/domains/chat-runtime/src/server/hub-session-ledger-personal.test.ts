/**
 * T-100: a computer that runs a task as someone's PERSONAL workspace (a user who did
 * not create it, on their own computer) is tracked — the task's pause, deletion and
 * erasure reach it — but never handed the task's own staged rows, session intents or
 * tab recovery: those are the creator's, for the creator's computer.
 */
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { createComputerSessionLedger } from './hub-session-ledger'

test("a personal computer is tracked, and handed nothing of the creator's", async () => {
  const h = await createTestHarness()
  const calls: string[] = []
  const ledger = createComputerSessionLedger({
    db: h.slayDb,
    request: async (computerId, req) => {
      calls.push(`request:${computerId}:${(req as { kind?: string }).kind ?? '?'}`)
      return null
    },
    target: async () => 'pc-creator',
    usable: () => true,
    flushTask: async (taskId, computerId) => void calls.push(`flush:${taskId}:${computerId}`),
    track: async (taskId, computerId) => void calls.push(`track:${taskId}:${computerId}`),
    recoverTabs: async (taskId, computerId) => void calls.push(`recover:${taskId}:${computerId}`),
    personal: async (_taskId, computerId) => computerId === 'pc-member'
  })
  await ledger.prepare('t1', 'pc-member')
  expect(calls).toEqual(['track:t1:pc-member'])
  calls.length = 0
  await ledger.prepare('t1', 'pc-creator')
  expect(calls).toContain('flush:t1:pc-creator')
  expect(calls).toContain('track:t1:pc-creator')
  expect(calls).toContain('recover:t1:pc-creator')
  h.cleanup()
})
