/**
 * Move-to-computer final review round 6 (follow-up to R5-1): on a hub WITHOUT login
 * that has several computers, the Trash purge removed an unbound task's worktree on
 * placement's CURRENT default computer — not on the computer the worktree was made
 * on. When the default had changed since (the task was created while only another
 * computer was connected), the removal found no such path there and "succeeded", the
 * row was purged, and the worktree stayed on the other computer for good.
 *
 * The worktree's computer is now recorded when the worktree is made, and the purge
 * (and archive) remove it there: wait while that computer is away, never blocked by
 * one that is gone for good. Wired exactly as the hub wires it
 * (`createTaskWorktreeRouting`, ./task-worktree-routing.ts).
 */
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/computers/server'
import type { RoutingGateway } from '@slayzone/computer-transport/server'
import {
  configureTaskRuntimeAdapters,
  createTaskOp,
  purgeExpiredTrash,
  updateTask
} from '@slayzone/task/server'
import { defaultWorktreePolicyAdapters, hubWorktreeExecAdapters } from '@slayzone/worktrees/server'
import { createComputerPlacement } from './computer-placement'
import { createTaskWorktreeRouting } from './task-worktree-routing'

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

test('purge removes the worktree on the computer that holds it, not the current default', async () => {
  const id = await taskWithWorktreeOnRemote()
  usable = [LOCAL, REMOTE] // the local computer connected: it is the default now
  await purgeExpiredTrash(h.slayDb)
  expect(removals()).toEqual([
    {
      computerId: REMOTE,
      projectPath: '/home/k/app',
      worktreePath: '/home/k/app-workspaces/on-remote'
    }
  ])
  expect(exists(id)).toBe(false)
})

test('its computer away: the row waits (nothing removed elsewhere), then goes on connect', async () => {
  const id = await taskWithWorktreeOnRemote()
  usable = [LOCAL] // only the default is connected
  await purgeExpiredTrash(h.slayDb)
  expect(removals()).toEqual([])
  expect(exists(id)).toBe(true)

  usable = [LOCAL, REMOTE] // the remote computer connects
  await purgeExpiredTrash(h.slayDb)
  expect(removals().map((r) => r.computerId)).toEqual([REMOTE])
  expect(exists(id)).toBe(false)
})

test('its computer gone for good (revoked) never blocks the purge', async () => {
  const id = await taskWithWorktreeOnRemote()
  h.db.prepare('UPDATE computers SET revoked_at = 5 WHERE id = ?').run(REMOTE)
  usable = [LOCAL]
  await purgeExpiredTrash(h.slayDb)
  expect(removals()).toEqual([])
  expect(exists(id)).toBe(false)
})

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
