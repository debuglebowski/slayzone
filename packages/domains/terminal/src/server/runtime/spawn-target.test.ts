/**
 * Which computer an agent session starts on, and in which folder — decided on the
 * hub BEFORE the spawn reaches the computer, because the conversation healer,
 * session detection and warm-agent matching all key off that folder.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { expect, test } from 'vitest'
import type { PtySpawnLookups } from './pty-data-ops'
import { resolveAgentFolder, resolveSpawnTarget } from './spawn-target'

const lookups = (over: Partial<PtySpawnLookups> = {}): PtySpawnLookups => ({
  getTerminalMode: async () => null,
  getTaskProjectId: async (taskId) => (taskId === 't1' ? 'p1' : null),
  resolveComputerId: async (taskId) => (taskId === 't1' ? 'c-task' : null),
  resolveProjectComputerId: async (projectId) => (projectId === 'p1' ? 'c-project' : null),
  getProjectRoot: async (projectId, computerId) => `/folders/${projectId}@${computerId}`,
  ...over
})

test('a task session with no folder given starts in its project’s folder on the task’s computer', async () => {
  expect(await resolveSpawnTarget('t1:t1', undefined, lookups())).toEqual({
    taskId: 't1',
    projectId: 'p1',
    computerId: 'c-task',
    cwd: '/folders/p1@c-task'
  })
})

// A worktree or a base dir is a folder the computer created or the user chose.
test('an explicit folder always wins', async () => {
  const target = await resolveSpawnTarget('t1:t1', '/work/tree', lookups())
  expect(target.cwd).toBe('/work/tree')
})

test('no folder known for the project on that computer: none given, so the computer decides', async () => {
  const target = await resolveSpawnTarget(
    't1:t1',
    undefined,
    lookups({ getProjectRoot: async () => null })
  )
  expect(target.cwd).toBe('')
  expect(target.projectId).toBe('p1')
})

// The project-wide agent panel is not a task: its session id names the project.
test('the global agent panel resolves its project and the project’s computer', async () => {
  expect(await resolveSpawnTarget('__global-agent-panel:p1:0', undefined, lookups())).toEqual({
    taskId: null,
    projectId: 'p1',
    computerId: 'c-project',
    cwd: '/folders/p1@c-project'
  })
})

test('no computer resolved: no folder is guessed', async () => {
  const target = await resolveSpawnTarget(
    't1:t1',
    undefined,
    lookups({ resolveComputerId: async () => null })
  )
  expect(target).toMatchObject({ computerId: null, cwd: '' })
})

// Chat agents use the same rule, so a chat and a terminal agent of one task start
// in the same folder.
test('resolveAgentFolder: explicit, else the hub’s folder on that computer, else none', async () => {
  const root = async (p: string, c: string) => (p === 'p1' && c === 'c1' ? '/f' : null)
  expect(await resolveAgentFolder('/explicit', 'p1', 'c1', root)).toBe('/explicit')
  expect(await resolveAgentFolder('', 'p1', 'c1', root)).toBe('/f')
  expect(await resolveAgentFolder(undefined, 'p1', 'c2', root)).toBe('')
  expect(await resolveAgentFolder(undefined, null, 'c1', root)).toBe('')
  expect(await resolveAgentFolder(undefined, 'p1', null, root)).toBe('')
})
