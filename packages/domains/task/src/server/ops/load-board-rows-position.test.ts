/**
 * `loadBoardRowsOp` names each returned row's board successor (`nextTaskIds`), so
 * the renderer can patch a created or moved row into its board at the place a full
 * reload would put it — and `createTaskOp` can therefore announce its insert as a
 * scoped change instead of forcing every window to reload the whole board.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../../shared/test-utils/ipc-harness.js'
import { createTaskOp } from './create.js'
import { loadBoardDataOp, loadBoardRowsOp } from './load-board-data.js'
import type { TasksChange } from '../../shared/tasks-changed.js'

async function setup() {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, 'Proj', '#000', '/tmp/proj', JSON.stringify([]))
  const changes: Array<TasksChange | undefined> = []
  const create = (title: string) =>
    createTaskOp(h.slayDb, { projectId, title }, { onMutation: (c) => changes.push(c) })
  return { h, projectId, changes, create }
}

test('nextTaskIds matches the full board order for every returned row', async () => {
  const s = await setup()
  const ids: string[] = []
  for (const title of ['a', 'b', 'c', 'd']) ids.push((await s.create(title))!.id)
  // Same order, same created_at second → rowid breaks the tie; move one row too.
  s.h.db.prepare('UPDATE tasks SET "order" = 5 WHERE id = ?').run(ids[1])
  const board = (await loadBoardDataOp(s.h.slayDb)).tasks.map((t) => t.id)
  const rows = await loadBoardRowsOp(s.h.slayDb, ids)
  for (const id of ids) {
    const at = board.indexOf(id)
    expect(rows.nextTaskIds[id]).toBe(at === board.length - 1 ? null : board[at + 1])
  }
  s.h.cleanup()
})

test('a deleted row has no successor entry', async () => {
  const s = await setup()
  const t = (await s.create('gone'))!
  s.h.db.prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?").run(t.id)
  const rows = await loadBoardRowsOp(s.h.slayDb, [t.id])
  expect(rows.tasks.length).toBe(0)
  expect(t.id in rows.nextTaskIds).toBe(false)
  s.h.cleanup()
})

test('create announces a scoped change naming only the new task', async () => {
  const s = await setup()
  const t = (await s.create('new'))!
  expect(s.changes.length).toBe(1)
  expect(JSON.stringify(s.changes[0])).toBe(JSON.stringify({ taskIds: [t.id] }))
  s.h.cleanup()
})
