/** Permanent cleanup uses the recorded worktree computer, including after task rows disappear. */
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/computers/server'
import type { RoutingGateway } from '@slayzone/computer-transport/server'
import { configureTaskRuntimeAdapters, createTaskOp, updateTask } from '@slayzone/task/server'
import { defaultWorktreePolicyAdapters, hubWorktreeExecAdapters } from '@slayzone/worktrees/server'
import { createComputerPlacement } from './computer-placement'
import { createTaskWorktreeRouting } from './task-worktree-routing'
import { eraseContent, resumeErasure, type ErasureOptions } from '@slayzone/content-erasure/server'

type Harness = Awaited<ReturnType<typeof createTestHarness>>

const LOCAL = 'c-local' // named DEFAULT_LOCAL_COMPUTER_NAME: the default once connected
const REMOTE = 'c-remote'

let h: Harness
let projectId: string
let usable: string[]
let calls: { computerId: string; method: string; params: unknown }[]

const gateway = {
  request: async (computerId: string, method: string, params?: unknown) => {
    calls.push({ computerId, method, params })
    if (method === 'git.isGitRepo') return { isGitRepo: true }
    if (method === 'git.getCurrentBranch') return { branch: 'main' }
    if (method === 'git.runWorktreeSetupScript') return { ran: false }
    if (method === 'git.removeWorktree') return {}
    if (method === 'fs.pathExists') return { exists: false }
    return {}
  },
  events: { on: () => undefined, off: () => undefined },
  listComputers: () => []
} as unknown as RoutingGateway

beforeEach(async () => {
  h = await createTestHarness()
  usable = []
  calls = []
  const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
  projectId = crypto.randomUUID()
  sql(
    `INSERT INTO projects (id, name, color, columns_config, auto_create_worktree_on_task_create)
     VALUES (?, 'P', '#000', '[]', 1)`,
    projectId
  )
  sql(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
     VALUES (?, ?, 'darwin', '1', '[]', 1), (?, 'remote', 'linux', '1', '[]', 1)`,
    LOCAL,
    DEFAULT_LOCAL_COMPUTER_NAME,
    REMOTE
  )
  for (const [computerId, root] of [
    [LOCAL, '/Users/k/app'],
    [REMOTE, '/home/k/app']
  ])
    sql(
      `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
       VALUES (?, ?, ?, 'ready', 1)`,
      computerId,
      projectId,
      root
    )

  const placement = createComputerPlacement({
    db: h.slayDb,
    requireLogin: false,
    usable: () => usable.map((computerId) => ({ computerId, name: computerName(computerId) }))
  })
  const routing = createTaskWorktreeRouting({
    db: h.slayDb,
    requireLogin: false,
    usable: () => usable.map((computerId) => ({ computerId })),
    forTask: (taskId) => placement.forTask(taskId)
  })
  configureTaskRuntimeAdapters({
    getDataRoot: () => mkdtempSync(join(tmpdir(), 'purge-owner-')),
    worktreePolicy: defaultWorktreePolicyAdapters,
    projectRootForTask: routing.projectRootForTask,
    worktreeRootForTask: routing.worktreeRootForTask,
    worktreeComputerState: routing.worktreeComputerState,
    worktrees: routing.remoteWorktrees({
      gateway,
      gate: placement.gate,
      local: hubWorktreeExecAdapters
    })
  })
})

const computerName = (id: string): string => (id === LOCAL ? DEFAULT_LOCAL_COMPUTER_NAME : 'remote')

/** A task made while only the remote computer was connected: its worktree is there. */
async function taskWithWorktreeOnRemote(): Promise<string> {
  usable = [REMOTE]
  const task = await createTaskOp(h.slayDb, { projectId, title: 'On remote' }, {})
  if (!task) throw new Error('task not created')
  const made = calls.filter((c) => c.method === 'git.createWorktree')
  expect(made.map((c) => c.computerId)).toEqual([REMOTE])
  // Deleted 31 days ago: due for the purge.
  h.db
    .prepare(`UPDATE tasks SET deleted_at = datetime('now', '-31 days') WHERE id = ?`)
    .run(task.id)
  calls = []
  return task.id
}

const removals = () =>
  calls
    .filter((c) => c.method === 'git.removeWorktree')
    .map((c) => ({ computerId: c.computerId, ...(c.params as object) }))
const exists = (id: string): boolean =>
  h.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id) !== undefined

test('erasure removes the worktree on the computer that holds it, not the current default', async () => {
  const id = await taskWithWorktreeOnRemote()
  usable = [LOCAL, REMOTE] // the local computer connected: it is the default now
  await eraseContent(h.slayDb, h.tmpDir(), { kind: 'tasks', ids: [id] }, cleanupOptions())
  expect(removals()).toEqual([
    {
      computerId: REMOTE,
      projectPath: '/home/k/app',
      worktreePath: '/home/k/app-workspaces/on-remote'
    }
  ])
  expect(exists(id)).toBe(false)
})

test('an offline worktree stays visibly incomplete after the task row is erased, then resumes', async () => {
  const id = await taskWithWorktreeOnRemote(),
    root = h.tmpDir()
  usable = [LOCAL]
  const report = await eraseContent(h.slayDb, root, { kind: 'tasks', ids: [id] }, cleanupOptions())
  expect(report.state).toBe('incomplete')
  expect(report.computers).toContainEqual(expect.objectContaining({ id: REMOTE, deleted: false }))
  expect(removals()).toEqual([])
  expect(exists(id)).toBe(false)
  usable = [LOCAL, REMOTE]
  const resumed = await resumeErasure(h.slayDb, root, report.id, cleanupOptions())
  expect(resumed.state).toBe('complete')
  expect(removals().map((r) => r.computerId)).toEqual([REMOTE])
})

test('a revoked computer cannot be silently counted as erased', async () => {
  const id = await taskWithWorktreeOnRemote()
  h.db.prepare('UPDATE computers SET revoked_at=5 WHERE id=?').run(REMOTE)
  usable = [LOCAL]
  const report = await eraseContent(
    h.slayDb,
    h.tmpDir(),
    { kind: 'tasks', ids: [id] },
    cleanupOptions()
  )
  expect(report.state).toBe('incomplete')
  expect(report.failures).toContain('WORKTREE_NOT_DELETED')
  expect(removals()).toEqual([])
})

function cleanupOptions(): ErasureOptions {
  return {
    cleanupComputer: async (request) => {
      if (!usable.includes(request.computerId)) throw new Error('offline')
      return request.taskIds.map((taskId) => ({
        taskId,
        revision: (
          h.db.prepare('SELECT revision FROM chat_task_lifecycle WHERE task_id=?').get(taskId) as {
            revision: number
          }
        ).revision,
        erased: true as const
      }))
    },
    cleanupWorktree: async (target) => {
      if (!target.computerId || !usable.includes(target.computerId)) throw new Error('offline')
      await gateway.request(target.computerId, 'git.removeWorktree', {
        projectPath: target.repoPath,
        worktreePath: target.path
      })
    }
  }
}

const madeOn = (id: string): string | null =>
  (
    h.db.prepare('SELECT worktree_computer_id AS c FROM tasks WHERE id = ?').get(id) as {
      c: string | null
    }
  ).c

test('a subtask shares its parent worktree, and the computer that holds it', async () => {
  usable = [REMOTE]
  const parent = await createTaskOp(h.slayDb, { projectId, title: 'Parent' }, {})
  if (!parent) throw new Error('no parent')
  usable = [LOCAL, REMOTE]
  const child = await createTaskOp(h.slayDb, { projectId, title: 'Child', parentId: parent.id }, {})
  if (!child) throw new Error('no child')
  expect(madeOn(parent.id)).toBe(REMOTE)
  expect(madeOn(child.id)).toBe(REMOTE)
})

test('a worktree path set by hand forgets the recorded computer; the same path keeps it', async () => {
  usable = [REMOTE]
  const task = await createTaskOp(h.slayDb, { projectId, title: 'Linked' }, {})
  if (!task) throw new Error('no task')
  const path = '/home/k/app-workspaces/linked'
  await updateTask(h.slayDb, { id: task.id, worktreePath: path })
  expect(madeOn(task.id)).toBe(REMOTE)
  await updateTask(h.slayDb, { id: task.id, worktreePath: '/elsewhere/wt' })
  expect(madeOn(task.id)).toBeNull()
})
