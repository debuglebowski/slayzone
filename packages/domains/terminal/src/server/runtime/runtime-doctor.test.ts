/**
 * Doctor's "can this task's computer start terminals at all?" rows.
 *
 * Doctor used to check only the agent binary and the shell — on the HUB. An
 * install whose scripts never ran leaves node-pty on the computer unable to exec
 * its spawn-helper, so every agent fails with "The computer couldn't start the
 * agent." while Doctor showed all green. The computer now answers for itself.
 */
import { expect, test } from 'vitest'
import { computerRuntimeResults } from './runtime-doctor'

const helper = {
  check: 'spawn-helper executable',
  detail: '/h/spawn-helper is not executable.',
  fix: "chmod +x '/h/spawn-helper'"
}

test('each install problem is a failing row with its fix', async () => {
  const results = await computerRuntimeResults('computer-1', {
    runtimeProblems: async () => [helper]
  })
  expect(results).toEqual([
    { check: helper.check, ok: false, detail: helper.detail, fix: helper.fix }
  ])
})

test('a usable install is one passing row', async () => {
  const results = await computerRuntimeResults('computer-1', { runtimeProblems: async () => [] })
  expect(results).toEqual([
    { check: 'Terminal runtime', ok: true, detail: 'This computer can start terminals.' }
  ])
})

test('nothing can tell (old computer, no routing backend, no computer): no row', async () => {
  expect(await computerRuntimeResults('computer-1', { runtimeProblems: async () => null })).toEqual(
    []
  )
  expect(await computerRuntimeResults('computer-1', {})).toEqual([])
  expect(
    await computerRuntimeResults(null, { runtimeProblems: async () => [helper] }),
    'no computer resolved for the task'
  ).toEqual([])
})

test('an unreachable computer is a failing row, not a thrown Doctor', async () => {
  const results = await computerRuntimeResults('computer-1', {
    runtimeProblems: async () => {
      throw new Error('connection closed')
    }
  })
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ check: 'Terminal runtime', ok: false })
  expect(results[0]!.detail).toContain('connection closed')
})
