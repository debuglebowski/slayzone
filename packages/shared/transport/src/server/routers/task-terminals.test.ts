/**
 * task-terminals router contract tests — exercise the procedures via tRPC
 * `createCaller` against the in-memory harness DB. Ports the coverage from the
 * legacy terminal-tabs IPC-handler test
 * (domains/task-terminals/src/electron/handlers.test.ts).
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { taskTerminalsRouter } from './task-terminals.js'

const h = await createTestHarness()
const ctx = { db: h.slayDb }
const caller = taskTerminalsRouter.createCaller(ctx)

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
const taskId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
  .run(taskId, projectId, 'T1', 'inbox', 3, 0)

test('task-terminals router: ensureMain creates → idempotent → mode update', async () => {
  const main = await caller.ensureMain({ taskId, mode: 'claude-code' })
  expect(main.isMain).toBe(true)
  expect(main.mode).toBe('claude-code')
  expect(main.position).toBe(0)
  expect(main.id).toBe(taskId)

  const again = await caller.ensureMain({ taskId, mode: 'claude-code' })
  expect(again.id).toBe(taskId)
  expect(again.isMain).toBe(true)

  const remoded = await caller.ensureMain({ taskId, mode: 'codex' })
  expect(remoded.mode).toBe('codex')
})

test('task-terminals router: list ordered by position', async () => {
  const tabs = await caller.list({ taskId })
  expect(tabs).toHaveLength(1)
  expect(tabs[0].position).toBe(0)
})

test('task-terminals router: create non-main (auto position) + custom label + default mode', async () => {
  const t1 = await caller.create({ taskId, mode: 'terminal' })
  expect(t1.isMain).toBe(false)
  expect(t1.position).toBe(1)
  expect(t1.label).toBeNull()
  expect(t1.mode).toBe('terminal')

  const t2 = await caller.create({ taskId, label: 'Build', mode: 'terminal' })
  expect(t2.label).toBe('Build')
  expect(t2.position).toBe(2)

  const t3 = await caller.create({ taskId })
  expect(t3.mode).toBe('terminal')
})

test('task-terminals router: update label set/clear, mode, null for missing', async () => {
  const nonMain = (await caller.list({ taskId })).find((t) => t.id !== taskId)!
  expect((await caller.update({ id: nonMain.id, label: 'Renamed' })).label).toBe('Renamed')
  expect((await caller.update({ id: nonMain.id, label: null })).label).toBeNull()
  expect((await caller.update({ id: nonMain.id, mode: 'codex' })).mode).toBe('codex')
  expect(await caller.update({ id: 'nope' })).toBeNull()
})

test('task-terminals router: delete non-main true, main false, missing false', async () => {
  const nonMain = (await caller.list({ taskId })).find((t) => t.id !== taskId)!
  expect(await caller.delete({ tabId: nonMain.id })).toBe(true)
  expect(await caller.delete({ tabId: taskId })).toBe(false)
  expect(await caller.delete({ tabId: 'nope' })).toBe(false)
})

test('task-terminals router: listAutoRestoreTasks — spawned+non-hibernated only', async () => {
  const mkTask = (title: string, deletedAt: string | null = null) => {
    const id = crypto.randomUUID()
    h.db
      .prepare(
        'INSERT INTO tasks (id, project_id, title, status, priority, "order", deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, projectId, title, 'inbox', 3, 0, deletedAt)
    return id
  }
  const setTab = (id: string, wasSpawned: boolean, hibernated: boolean) =>
    h.db
      .prepare('UPDATE terminal_tabs SET was_spawned = ?, hibernated = ? WHERE id = ?')
      .run(wasSpawned ? 1 : 0, hibernated ? 1 : 0, id)

  const active = mkTask('active')
  await caller.ensureMain({ taskId: active, mode: 'claude-code' })
  setTab(active, true, false)

  const hibernated = mkTask('hibernated')
  await caller.ensureMain({ taskId: hibernated, mode: 'claude-code' })
  setTab(hibernated, true, true)

  const neverSpawned = mkTask('never-spawned')
  await caller.ensureMain({ taskId: neverSpawned, mode: 'claude-code' })
  setTab(neverSpawned, false, false)

  const plainShell = mkTask('plain-shell')
  await caller.ensureMain({ taskId: plainShell, mode: 'terminal' })
  setTab(plainShell, true, false)

  const deleted = mkTask('deleted', new Date().toISOString())
  await caller.ensureMain({ taskId: deleted, mode: 'claude-code' })
  setTab(deleted, true, false)

  const ids = await caller.listAutoRestoreTasks()
  expect(ids).toContain(active)
  expect(ids).not.toContain(hibernated)
  expect(ids).not.toContain(neverSpawned)
  expect(ids).not.toContain(plainShell)
  expect(ids).not.toContain(deleted)
})
