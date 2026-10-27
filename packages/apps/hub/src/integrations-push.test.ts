/**
 * Integration push-on-edit must fire in the SIDE-CAR.
 *
 * THE BUG THIS PINS (silent since the slice-9 cutover): the task ops emit their
 * `db:tasks:*:done` signals on an INJECTED bus —
 * `packages/domains/task/src/server/ops/update.ts:25` does
 * `ipcMain?.emit('db:tasks:update:done', …)`, where `ipcMain` is whatever the
 * composition root handed them. In local mode the ops run HERE, and this process's
 * bus is a plain `EventEmitter` (`composition.ts:332`) — not the Electron host's
 * `ipcMain`. The host nonetheless kept the only listeners, so every push to
 * Linear/GitHub after a task edit has been going nowhere, along with the
 * `external_links` lookup that gated the refetch notification.
 *
 * Restoring this CHANGES BEHAVIOR — pushes that have not fired for releases start
 * firing again. That is the point, but it is worth verifying against a real
 * provider connection before shipping.
 *
 * The push functions are injected so this test can observe them without standing
 * up Linear/GitHub; production passes the real ones by default.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { wireIntegrationPush } from './integrations-push.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
const taskId = crypto.randomUUID()
h.db
  .prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(taskId, projectId, 'T', 'inbox', 3, 0)

type Calls = Record<string, unknown[][]>

function wired(): { bus: EventEmitter; calls: Calls; notified: () => number } {
  const bus = new EventEmitter()
  const calls: Calls = { edit: [], create: [], archive: [], unarchive: [] }
  let notifyCount = 0
  wireIntegrationPush({
    db: h.slayDb,
    taskBus: bus,
    notifyTasksChanged: () => {
      notifyCount++
    },
    pushGithubTask: async () => {},
    fns: {
      pushTaskAfterEdit: async (...a: unknown[]) => void calls.edit.push(a),
      pushNewTaskToProviders: async (...a: unknown[]) => void calls.create.push(a),
      pushArchiveToProviders: async (...a: unknown[]) => void calls.archive.push(a),
      pushUnarchiveToProviders: async (...a: unknown[]) => void calls.unarchive.push(a)
    }
  })
  return { bus, calls, notified: () => notifyCount }
}

/** The ops emit with a leading null (ipcMain.emit's event arg). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

test('db:tasks:update:done without before/after → pushTaskAfterEdit (fail open)', async () => {
  const { bus, calls } = wired()
  bus.emit('db:tasks:update:done', null, taskId, { oldStatus: 'inbox' })
  await flush()
  expect(calls.edit.length).toBe(1)
  expect(calls.edit[0][1]).toBe(taskId)
})

/** A task as the update ops report it, before or after. */
const snap = (over: Record<string, unknown> = {}) => ({
  id: taskId,
  project_id: projectId,
  title: 'T',
  description: null,
  status: 'inbox',
  priority: 3,
  is_temporary: false,
  editor_open_files: null,
  ...over
})

test('an update that changes a synced field re-syncs the task', async () => {
  for (const changed of [
    { title: 'T2' },
    { description: '<p>d</p>' },
    { status: 'done' },
    { priority: 1 }
  ]) {
    const { bus, calls } = wired()
    bus.emit('db:tasks:update:done', null, taskId, {
      oldStatus: 'inbox',
      previous: snap(),
      next: snap(changed)
    })
    await flush()
    expect(calls.edit.length).toBe(1)
  }
})

test('an update that changes no synced field (UI state) does not re-sync', async () => {
  // The app saves open editor files, web panel URLs, the active artifact and the
  // unread flag through task.update — none of them exist on the issue.
  const { bus, calls } = wired()
  bus.emit('db:tasks:update:done', null, taskId, {
    oldStatus: 'inbox',
    previous: snap(),
    next: snap({ editor_open_files: '["a.ts"]' })
  })
  await flush()
  expect(calls.edit.length).toBe(0)
  expect(calls.create.length).toBe(0)
})

test('a temporary task made permanent is pushed as a new task', async () => {
  const { bus, calls } = wired()
  bus.emit('db:tasks:update:done', null, taskId, {
    oldStatus: 'inbox',
    previous: snap({ is_temporary: true }),
    next: snap({ is_temporary: false, title: 'Real now' })
  })
  await flush()
  expect(calls.create.length).toBe(1)
  expect(calls.create[0][1]).toBe(taskId)
  expect(calls.create[0][2]).toBe(projectId)
  expect(calls.edit.length).toBe(0)
})

test('a new temporary task is not pushed', async () => {
  // Scratch terminals ("Terminal 1") are temporary; in a two-way-synced project
  // each one used to become a Linear/GitHub issue.
  const tempId = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order", is_temporary) VALUES (?, ?, ?, ?, ?, ?, 1)'
    )
    .run(tempId, projectId, 'Terminal 1', 'inbox', 3, 0)
  const { bus, calls } = wired()
  bus.emit('db:tasks:create:done', null, tempId, projectId)
  await flush()
  expect(calls.create.length).toBe(0)
})

test('db:tasks:create:done → pushNewTaskToProviders', async () => {
  const { bus, calls } = wired()
  bus.emit('db:tasks:create:done', null, taskId, projectId)
  await flush()
  expect(calls.create.length).toBe(1)
  expect(calls.create[0][1]).toBe(taskId)
  expect(calls.create[0][2]).toBe(projectId)
})

test('create notifies only when a link was actually written', async () => {
  const { bus, notified } = wired()
  bus.emit('db:tasks:create:done', null, taskId, projectId)
  await flush()
  // No external_links row for this task → no refetch ping.
  expect(notified()).toBe(0)

  // external_links.connection_id is a real FK and foreign_keys is ON, so the
  // connection has to exist first.
  const connectionId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO integration_connections (id, provider, credential_ref) VALUES (?, ?, ?)')
    .run(connectionId, 'github', 'ref1')
  h.db
    .prepare(
      "INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, task_id) VALUES (?, 'github', ?, 'issue', '1', 'K-1', ?)"
    )
    .run(crypto.randomUUID(), connectionId, taskId)
  const second = wired()
  second.bus.emit('db:tasks:create:done', null, taskId, projectId)
  await flush()
  expect(second.notified()).toBe(1)
})

test('archive + unarchive both push', async () => {
  const { bus, calls } = wired()
  bus.emit('db:tasks:archive:done', null, taskId)
  bus.emit('db:tasks:unarchive:done', null, taskId)
  await flush()
  expect(calls.archive.length).toBe(1)
  expect(calls.unarchive.length).toBe(1)
})
