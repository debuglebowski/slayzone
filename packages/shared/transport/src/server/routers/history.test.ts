/**
 * history router contract tests (cross-domain: task + tags + history) — exercise
 * the procedures via tRPC `createCaller` against the harness DB. Ports the
 * coverage from the legacy task-history integration test
 * (domains/task/src/electron/history.test.ts): task/tag ops record activity
 * events, rollback-on-history-insert-failure, and cursor pagination.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { taskRouter } from './task.js'
import { tagsRouter } from './tags.js'
import { historyRouter } from './history.js'
import { setTaskDeps } from '../app-deps.js'
import { taskOps, configureTaskRuntimeAdapters } from '@slayzone/task/server'
import type { Task } from '@slayzone/task/shared'

const h = await createTestHarness()
setTaskDeps({ ops: taskOps })
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-history-')) }
configureTaskRuntimeAdapters({ getDataRoot: () => ctx.dataRoot })

const task = taskRouter.createCaller(ctx)
const tags = tagsRouter.createCaller(ctx)
const history = historyRouter.createCaller(ctx)

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'HistoryProject', '#000', '/tmp/history-project')

const createTask = (title: string, extra?: Record<string, unknown>): Promise<Task> =>
  task.create({ projectId, title, ...extra } as never) as Promise<Task>

const listTaskEvents = (taskId: string): Array<{ kind: string; summary: string; payload_json: string | null }> =>
  h.db
    .prepare(
      `SELECT kind, summary, payload_json FROM activity_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`
    )
    .all(taskId) as Array<{ kind: string; summary: string; payload_json: string | null }>

const withFailingActivityEventInsert = async (fn: () => Promise<unknown>): Promise<void> => {
  h.db.exec(`
    CREATE TEMP TRIGGER fail_activity_event_insert
    BEFORE INSERT ON activity_events
    BEGIN SELECT RAISE(FAIL, 'activity event insert failed'); END;
  `)
  try {
    await fn()
  } finally {
    h.db.exec('DROP TRIGGER IF EXISTS fail_activity_event_insert')
  }
}
const didThrow = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

test('history: creating a task records task.created', async () => {
  const t = await createTask('History create')
  const events = listTaskEvents(t.id)
  expect(events).toHaveLength(1)
  expect(events[0].kind).toBe('task.created')
  expect(events[0].summary).toBe('Task created')
})

test('history: updating title + status records semantic events', async () => {
  const t = await createTask('Before')
  await task.update({ id: t.id, title: 'After', status: 'in_progress' } as never)
  expect(listTaskEvents(t.id).map((e) => e.kind)).toEqual([
    'task.created',
    'task.title_changed',
    'task.status_changed'
  ])
})

test('history: description change stores metadata only (no full text)', async () => {
  const t = await createTask('Description task', { description: 'old text' })
  await task.update({ id: t.id, description: '# New body' } as never)
  const descEvent = listTaskEvents(t.id).find((e) => e.kind === 'task.description_changed')
  expect(Boolean(descEvent)).toBe(true)
  const payload = JSON.parse(descEvent?.payload_json ?? '{}') as Record<string, unknown>
  expect(payload.beforeLength).toBe(8)
  expect(payload.afterLength).toBe(10)
  expect(payload.before).toBeUndefined()
})

test('history: setForTask records added + removed tag ids', async () => {
  const t = await createTask('Tag task')
  const tagA = await tags.create({ projectId, name: 'Alpha', color: '#aa1111', textColor: '#fff' })
  const tagB = await tags.create({ projectId, name: 'Beta', color: '#bb2222', textColor: '#fff' })
  await tags.setForTask({ taskId: t.id, tagIds: [tagA.id, tagB.id] })
  await tags.setForTask({ taskId: t.id, tagIds: [tagB.id] })

  const events = listTaskEvents(t.id).filter((e) => e.kind === 'task.tags_changed')
  expect(events).toHaveLength(2)
  const first = JSON.parse(events[0].payload_json ?? '{}') as Record<string, unknown>
  expect(first.addedTagIds).toEqual([tagA.id, tagB.id])
  expect(first.removedTagIds).toEqual([])
  const second = JSON.parse(events[1].payload_json ?? '{}') as Record<string, unknown>
  expect(second.addedTagIds).toEqual([])
  expect(second.removedTagIds).toEqual([tagA.id])
})

test('history: task create rolls back when history insert fails', async () => {
  expect(
    await didThrow(() =>
      withFailingActivityEventInsert(() => task.create({ projectId, title: 'Rollback create' } as never))
    )
  ).toBe(true)
  expect(h.db.prepare('SELECT id FROM tasks WHERE title = ?').get('Rollback create')).toBeUndefined()
})

test('history: task update rolls back when history insert fails', async () => {
  const t = await createTask('Rollback update')
  expect(
    await didThrow(() =>
      withFailingActivityEventInsert(() =>
        task.update({ id: t.id, title: 'Changed title', status: 'in_progress' } as never)
      )
    )
  ).toBe(true)
  const row = h.db.prepare('SELECT title, status FROM tasks WHERE id = ?').get(t.id) as {
    title: string
    status: string
  }
  expect(row.title).toBe('Rollback update')
  expect(row.status).toBe(t.status)
  expect(listTaskEvents(t.id).map((e) => e.kind)).toEqual(['task.created'])
})

test('history: tag change rolls back when history insert fails', async () => {
  const t = await createTask('Rollback tags')
  const tag = await tags.create({ projectId, name: 'RollbackTag', color: '#cc3333', textColor: '#fff' })
  expect(
    await didThrow(() =>
      withFailingActivityEventInsert(() => tags.setForTask({ taskId: t.id, tagIds: [tag.id] }))
    )
  ).toBe(true)
  expect(h.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(t.id)).toHaveLength(0)
  expect(listTaskEvents(t.id).map((e) => e.kind)).toEqual(['task.created'])
})

test('history: listForTask paginates deterministically with a cursor', async () => {
  const t = await createTask('Paged task')
  h.db.prepare('DELETE FROM activity_events WHERE task_id = ?').run(t.id)
  const insert = h.db.prepare(`
    INSERT INTO activity_events (id, entity_type, entity_id, project_id, task_id, kind, actor_type, source, summary, payload_json, created_at)
    VALUES (?, 'task', ?, ?, ?, 'task.status_changed', 'user', 'task', ?, NULL, ?)
  `)
  const createdAt = '2026-04-01T10:00:00.000Z'
  insert.run('event-a', t.id, t.project_id, t.id, 'Event A', createdAt)
  insert.run('event-b', t.id, t.project_id, t.id, 'Event B', createdAt)
  insert.run('event-c', t.id, t.project_id, t.id, 'Event C', createdAt)

  const firstPage = (await history.listForTask({ taskId: t.id, options: { limit: 2 } })) as {
    events: Array<{ id: string }>
    nextCursor: { createdAt: string; id: string } | null
  }
  expect(firstPage.events.map((e) => e.id)).toEqual(['event-c', 'event-b'])
  expect(firstPage.nextCursor).toEqual({ createdAt, id: 'event-b' })

  const secondPage = (await history.listForTask({
    taskId: t.id,
    options: { limit: 2, before: firstPage.nextCursor }
  })) as { events: Array<{ id: string }>; nextCursor: { createdAt: string; id: string } | null }
  expect(secondPage.events.map((e) => e.id)).toEqual(['event-a'])
  expect(secondPage.nextCursor).toBeNull()
})
