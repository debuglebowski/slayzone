/**
 * Every task op names the rows it changed (`TasksChange`), so a client patches those
 * rows instead of reloading the whole board (MBs). Archive, delete, restore, bulk
 * updates and the browser-tab lock used to send "anything may have changed".
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import type { TasksChange } from '@slayzone/task-contracts'
import { createTaskOp } from './create.js'
import { archiveTaskOp } from './archive.js'
import { archiveManyTasksOp } from './archive-many.js'
import { unarchiveTaskOp } from './unarchive.js'
import { restoreTaskOp } from './restore.js'
import { deleteTaskOp } from './delete.js'
import { deleteManyTasksOp } from './delete-many.js'
import { updateManyTasksOp } from './update-many.js'
import { setBrowserTabLockedOp } from './set-browser-tab-locked.js'
import { addBlockerOp } from './deps-add-blocker.js'
import { configureTaskRuntimeAdapters } from './shared.js'

async function setup() {
  const h = await createTestHarness()
  const root = h.tmpDir()
  configureTaskRuntimeAdapters({
    getDataRoot: () => root,
    killPtysByTaskId: () => {},
    removeTaskProcesses: () => {}
  })
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, 'Proj', '#000', '/tmp/proj', JSON.stringify([]))
  const changes: Array<TasksChange | undefined> = []
  const deps = { onMutation: (c?: TasksChange) => changes.push(c) }
  const create = async (title: string, parentId?: string) =>
    (await createTaskOp(h.slayDb, { projectId, title, parentId }, {}))!.id
  /** The one change the op under test sent, its ids sorted. */
  const last = () => {
    expect(changes).toHaveLength(1)
    const c = changes[0]
    expect(c, 'a scoped change, not "anything may have changed"').toBeDefined()
    return { ...c!, taskIds: [...c!.taskIds].sort() }
  }
  return { h, deps, changes, create, last }
}

test('archive names the task and its subtasks', async () => {
  const s = await setup()
  const parent = await s.create('p')
  const child = await s.create('c', parent)
  await archiveTaskOp(s.h.slayDb, parent, s.deps)
  expect(s.last().taskIds).toEqual([parent, child].sort())
  s.h.cleanup()
})

test('archive many names every archived task and subtask', async () => {
  const s = await setup()
  const a = await s.create('a')
  const b = await s.create('b')
  const bChild = await s.create('bc', b)
  await archiveManyTasksOp(s.h.slayDb, [a, b], s.deps)
  expect(s.last().taskIds).toEqual([a, b, bChild].sort())
  s.h.cleanup()
})

test('unarchive names the task', async () => {
  const s = await setup()
  const a = await s.create('a')
  await archiveTaskOp(s.h.slayDb, a, {})
  await unarchiveTaskOp(s.h.slayDb, a, s.deps)
  expect(s.last().taskIds).toEqual([a])
  s.h.cleanup()
})

test('restore names the task', async () => {
  const s = await setup()
  const a = await s.create('a')
  s.h.db.prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?").run(a)
  await restoreTaskOp(s.h.slayDb, a, s.deps)
  expect(s.last().taskIds).toEqual([a])
  s.h.cleanup()
})

test('delete names the task, its re-parented subtasks and its dependency neighbours', async () => {
  const s = await setup()
  const a = await s.create('a')
  const child = await s.create('c', a)
  const blocked = await s.create('blocked by a')
  const blocker = await s.create('blocks a')
  await addBlockerOp(s.h.slayDb, blocked, a)
  await addBlockerOp(s.h.slayDb, a, blocker)
  await deleteTaskOp(s.h.slayDb, a, s.deps)
  expect(s.last().taskIds).toEqual([a, child, blocked, blocker].sort())
  s.h.cleanup()
})

test('delete many names the deleted tasks, survivors and neighbours', async () => {
  const s = await setup()
  const a = await s.create('a')
  const b = await s.create('b')
  const child = await s.create('c', b)
  const blocked = await s.create('blocked by a')
  await addBlockerOp(s.h.slayDb, blocked, a)
  await deleteManyTasksOp(s.h.slayDb, [a, b], s.deps)
  expect(s.last().taskIds).toEqual([a, b, child, blocked].sort())
  s.h.cleanup()
})

test('update many names the updated tasks', async () => {
  const s = await setup()
  const a = await s.create('a')
  const b = await s.create('b')
  await updateManyTasksOp(s.h.slayDb, { ids: [a, b], updates: { priority: 1 } }, s.deps)
  expect(s.last().taskIds).toEqual([a, b].sort())
  s.h.cleanup()
})

test('browser-tab lock names the task', async () => {
  const s = await setup()
  const a = await s.create('a')
  s.h.db
    .prepare('UPDATE tasks SET browser_tabs = ? WHERE id = ?')
    .run(JSON.stringify({ tabs: [{ id: 't1' }], activeTabId: 't1' }), a)
  await setBrowserTabLockedOp(s.h.slayDb, a, 't1', true, s.deps)
  expect(s.last().taskIds).toEqual([a])
  s.h.cleanup()
})
