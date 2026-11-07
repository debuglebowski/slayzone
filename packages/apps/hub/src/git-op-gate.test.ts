/**
 * The computer gate on a git op (hubs with login): on a task's checkout, the computer
 * must serve that task. Whether the caller may use the computer at all is the
 * gateway's one owner check (computer-request-authorizer.test.ts), not asked here.
 * Hub-internal reads — the conversation healer's branch probe, the worktree colour
 * detector — have no caller and pass.
 */
import { expect, test, vi } from 'vitest'
import { createGitOpGate } from './git-op-gate'

test("a caller's task op: the computer must serve the task", async () => {
  const gate = vi.fn(async () => undefined)
  await createGitOpGate(gate, () => 'user-1')('c1', { taskId: 't1' })
  expect(gate.mock.calls).toEqual([['c1', { kind: 'task', id: 't1' }]])
})

test("a caller's op on a project or computer: nothing more than the gateway's check", async () => {
  const gate = vi.fn(async () => undefined)
  await createGitOpGate(gate, () => 'user-1')('c1', { projectId: 'p1' })
  expect(gate).not.toHaveBeenCalled()
})

test('hub-internal work (no caller) is not refused as nobody’s request', async () => {
  const gate = vi.fn(async () => {
    throw new Error('refused')
  })
  await expect(createGitOpGate(gate, () => null)('c1', { taskId: 't1' })).resolves.toBeUndefined()
  expect(gate).not.toHaveBeenCalled()
})

test('no gate (a hub without login): nothing asked', async () => {
  await expect(createGitOpGate(undefined, () => 'u')('c1', {})).resolves.toBeUndefined()
})
