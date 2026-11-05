/**
 * The computer gate on a git op (hubs with login). A caller's op is gated as what it
 * works on: a task's checkout as that task's work, anything else as the caller's own
 * request. Hub-internal reads — the conversation healer's branch probe, the worktree
 * colour detector — have no caller: gating them as "the caller's own request" refused
 * them on every login hub (the healer silently lost its branch signal). They are the
 * hub's own work on paths it chose, and pass.
 */
import { expect, test, vi } from 'vitest'
import { createGitOpGate } from './git-op-gate'

test("a caller's task op is gated as the task's work", async () => {
  const gate = vi.fn(async () => undefined)
  await createGitOpGate(gate, () => 'user-1')('c1', { taskId: 't1' })
  expect(gate).toHaveBeenCalledWith('c1', { kind: 'task', id: 't1' })
})

test("a caller's op on a project or computer is the caller's own request", async () => {
  const gate = vi.fn(async () => undefined)
  await createGitOpGate(gate, () => 'user-1')('c1', { projectId: 'p1' })
  expect(gate).toHaveBeenCalledWith('c1', null)
})

test('hub-internal work (no caller) is not refused as nobody’s request', async () => {
  const gate = vi.fn(async () => {
    throw new Error('refused')
  })
  await expect(
    createGitOpGate(gate, () => null)('c1', { projectId: 'p1' })
  ).resolves.toBeUndefined()
  expect(gate).not.toHaveBeenCalled()
})

test('no gate (a hub without login): nothing asked', async () => {
  await expect(createGitOpGate(undefined, () => 'u')('c1', {})).resolves.toBeUndefined()
})
