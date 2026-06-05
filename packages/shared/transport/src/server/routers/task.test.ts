/**
 * task router contract tests — exercise the procedures via tRPC `createCaller`
 * against the in-memory harness DB (async SlayzoneDb) with the real injected ops.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import type { CreateTaskInput, UpdateTaskInput } from '@slayzone/task/shared'
import { taskRouter } from './task.js'
import { setTaskDeps } from '../app-deps.js'
import { taskOps } from '@slayzone/task/main'
import { taskEvents } from '@slayzone/task/server'

const h = await createTestHarness()
setTaskDeps({ ops: taskOps })

const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-task-')) }
const caller = taskRouter.createCaller(ctx)

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
  .run(
    projectId,
    'P',
    '#000',
    '/tmp/p',
    JSON.stringify([
      { id: 'todo', label: 'To Do', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
    ])
  )

const mk = (title: string): CreateTaskInput => ({ projectId, title }) as unknown as CreateTaskInput

test('task router: create → getAll → get', async () => {
  const created = await caller.create(mk('Alpha'))
  expect(created.title).toBe('Alpha')
  expect((await caller.getAll()).length).toBeGreaterThanOrEqual(1)
  const got = await caller.get({ id: created.id })
  expect(got?.id).toBe(created.id)
})

test('task router: update → archive → unarchive', async () => {
  const t = await caller.create(mk('Beta'))
  const up = await caller.update({ id: t.id, title: 'Beta2' } as unknown as UpdateTaskInput)
  expect(up.title).toBe('Beta2')
  expect((await caller.archive({ id: t.id })).id).toBe(t.id)
  expect((await caller.unarchive({ id: t.id })).id).toBe(t.id)
})

test('task router: dependencies (add → get → blocked → remove)', async () => {
  const a = await caller.create(mk('blocker'))
  const b = await caller.create(mk('blocked'))
  await caller.addBlocker({ taskId: b.id, blockerTaskId: a.id })
  expect((await caller.getBlockers({ taskId: b.id })).length).toBe(1)
  expect(await caller.getAllBlockedTaskIds()).toContain(b.id)
  await caller.removeBlocker({ taskId: b.id, blockerTaskId: a.id })
  expect((await caller.getBlockers({ taskId: b.id })).length).toBe(0)
})

test('task router: loadBoardData', async () => {
  const board = await caller.loadBoardData()
  expect(board.projects.length).toBeGreaterThanOrEqual(1)
  expect(Array.isArray(board.tasks)).toBeTruthy()
})

test('task router: create fires taskEvents (backs the onChanged subscription)', async () => {
  let fired = 0
  const handler = (): void => {
    fired++
  }
  taskEvents.on('task:created', handler)
  await caller.create(mk('evented'))
  taskEvents.off('task:created', handler)
  expect(fired).toBeGreaterThanOrEqual(1)
})

// Contract the migration ADDED: these procedures throw NOT_FOUND on a missing id
// (the IPC handlers returned null). Surfaces what IPC hid; the renderer must handle
// the throw at cutover (slice 5).
test('task router: missing id throws (NOT_FOUND, not silent null)', async () => {
  const throws = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      return false
    } catch {
      return true
    }
  }
  expect(await throws(() => caller.update({ id: 'nope', title: 'x' } as unknown as UpdateTaskInput))).toBeTruthy()
  expect(await throws(() => caller.archive({ id: 'nope' }))).toBeTruthy()
  expect(await throws(() => caller.restore({ id: 'nope' }))).toBeTruthy()
  expect(await throws(() => caller.unarchive({ id: 'nope' }))).toBeTruthy()
})
