import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createComputerMoves, type ComputerMoveHost } from './computer-move'

const h = await createTestHarness()
afterAll(() => h.cleanup())
const calls: string[] = []
const host: ComputerMoveHost = {
  resolve: async () => 'source',
  destination: async () => 'target',
  inspect: async () => ({ ready: true, blockers: [], agents: [] }),
  cloneRepository: async () => {
    calls.push('clone')
  },
  stop: async () => {
    calls.push('stop')
  },
  copyWorkspace: async (_move, progress) => {
    calls.push('files')
    await progress(10, 10)
  },
  copySessions: async () => {
    calls.push('sessions')
    return []
  },
  verifySource: async () => {
    calls.push('verify')
  },
  activate: async () => {
    calls.push('activate')
  },
  cancel: async () => {
    calls.push('cancel')
  },
  finish: async () => {
    calls.push('finish')
  },
  changed: () => {
    calls.push('changed')
  }
}
beforeEach(async () => {
  calls.length = 0
  vi.restoreAllMocks()
  h.db.prepare('DELETE FROM task_computer_moves').run()
  h.db
    .prepare("INSERT OR IGNORE INTO projects(id,name,color) VALUES('project','Project','#000')")
    .run()
  h.db
    .prepare(
      "INSERT OR REPLACE INTO tasks(id,project_id,title,status,computer_id,has_worktree,worktree_computer_id) VALUES('task','project','Task','inbox','source',1,'source')"
    )
    .run()
})
const bound = () =>
  h.db
    .prepare("SELECT computer_id,worktree_computer_id,project_id FROM tasks WHERE id='task'")
    .get()
it('switches task and folder ownership only after verified files and sessions', async () => {
  const moves = createComputerMoves(h.slayDb, host)
  const pending = await moves.begin({
    taskId: 'task',
    computerId: 'target',
    allowFreshSessions: false
  })
  expect(bound()).toMatchObject({ computer_id: 'source', worktree_computer_id: 'source' })
  const done = await moves.run(pending.taskId)
  expect(done.status).toBe('done')
  expect(bound()).toEqual({
    computer_id: 'target',
    worktree_computer_id: 'target',
    project_id: 'project'
  })
  expect(calls).toEqual(['stop', 'files', 'activate', 'sessions', 'verify', 'finish', 'changed'])
})
it('retains source binding on failure and resumes from durable journal after restart', async () => {
  vi.spyOn(host, 'copyWorkspace').mockRejectedValueOnce(new Error('Disconnected'))
  const moves = createComputerMoves(h.slayDb, host)
  await moves.begin({ taskId: 'task', computerId: 'target', allowFreshSessions: false })
  expect((await moves.run('task')).status).toBe('failed')
  expect(bound()).toMatchObject({ computer_id: 'source', worktree_computer_id: 'source' })
  const restarted = createComputerMoves(h.slayDb, host)
  expect((await restarted.run('task')).status).toBe('done')
})
it('cancels failed moves without changing source, refuses simultaneous moves', async () => {
  vi.spyOn(host, 'copySessions').mockRejectedValueOnce(new Error('Missing transcript'))
  const moves = createComputerMoves(h.slayDb, host)
  await moves.begin({ taskId: 'task', computerId: 'target', allowFreshSessions: false })
  await expect(
    moves.begin({ taskId: 'task', computerId: 'elsewhere', allowFreshSessions: false })
  ).rejects.toThrow(/already/i)
  await moves.run('task')
  expect((await moves.cancel('task')).status).toBe('canceled')
  expect(bound()).toMatchObject({ computer_id: 'source' })
})
it('requires explicit consent before unsupported sessions start fresh', async () => {
  vi.spyOn(host, 'inspect').mockResolvedValueOnce({
    ready: true,
    blockers: [],
    agents: [
      { tabId: 'tab', label: 'Gemini', canResume: false, reason: 'No portable session format' }
    ]
  })
  const moves = createComputerMoves(h.slayDb, host)
  await expect(
    moves.begin({ taskId: 'task', computerId: 'target', allowFreshSessions: false })
  ).rejects.toThrow(/fresh/i)
  expect(await moves.get('task')).toBeNull()
})
it('does not mark an uncommitted move as finished when the ownership transaction fails', async () => {
  const moves = createComputerMoves(h.slayDb, host)
  await moves.begin({ taskId: 'task', computerId: 'target', allowFreshSessions: false })
  const transaction = h.slayDb.namedTxn.bind(h.slayDb)
  vi.spyOn(h.slayDb, 'namedTxn').mockImplementation(async (name, args) => {
    if (name === 'task:commit-computer-move') throw new Error('Commit failed')
    return transaction(name, args)
  })
  const failed = await moves.run('task')
  expect(failed).toMatchObject({ status: 'failed', step: 'commit' })
  expect(bound()).toMatchObject({ computer_id: 'source' })
  expect((await moves.cancel('task')).status).toBe('canceled')
})
it('recovers a committed move when the transaction acknowledgement was lost', async () => {
  const moves = createComputerMoves(h.slayDb, host)
  await moves.begin({ taskId: 'task', computerId: 'target', allowFreshSessions: false })
  const transaction = h.slayDb.namedTxn.bind(h.slayDb)
  vi.spyOn(h.slayDb, 'namedTxn').mockImplementation(async (name, args) => {
    const result = await transaction(name, args)
    if (name === 'task:commit-computer-move') throw new Error('Acknowledgement lost')
    return result
  })
  expect((await moves.run('task')).step).toBe('finish')
  expect(bound()).toMatchObject({ computer_id: 'target' })
  expect((await moves.run('task')).status).toBe('done')
})
it('refuses stale task metadata at commit, leaving ownership on source', async () => {
  vi.spyOn(host, 'verifySource').mockImplementationOnce(async () => {
    h.db.prepare("UPDATE projects SET default_computer_id='changed' WHERE id='project'").run()
  })
  const moves = createComputerMoves(h.slayDb, host)
  await moves.begin({ taskId: 'task', computerId: 'target', allowFreshSessions: false })
  expect((await moves.run('task')).status).toBe('failed')
  expect(bound()).toMatchObject({ computer_id: 'source', worktree_computer_id: 'source' })
})
