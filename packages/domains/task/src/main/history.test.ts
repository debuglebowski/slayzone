/**
 * Task history integration tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ../../../../shared/test-utils/loader.ts src/main/history.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerTaskHandlers } from './handlers.js'
import { registerTagHandlers } from '@slayzone/tags/main'
import { registerHistoryHandlers } from '@slayzone/history/main'
import type { Task } from '../shared/types.js'

const h = await createTestHarness()
registerTaskHandlers(h.ipcMain as never, h.db)
registerTagHandlers(h.ipcMain as never, h.db)
registerHistoryHandlers(h.ipcMain as never, h.db)

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'HistoryProject', '#000', '/tmp/history-project')

async function createTask(title: string, extra?: Record<string, unknown>): Promise<Task> {
  return await h.invoke('db:tasks:create', { projectId, title, ...extra }) as Task
}

function listTaskEvents(taskId: string) {
  return h.db.prepare(`
    SELECT kind, summary, payload_json
    FROM activity_events
    WHERE task_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(taskId) as Array<{ kind: string; summary: string; payload_json: string | null }>
}

async function withFailingActivityEventInsert(fn: () => unknown | Promise<unknown>): Promise<unknown> {
  h.db.exec(`
    CREATE TEMP TRIGGER fail_activity_event_insert
    BEFORE INSERT ON activity_events
    BEGIN
      SELECT RAISE(FAIL, 'activity event insert failed');
    END;
  `)
  try {
    return await fn()
  } finally {
    h.db.exec('DROP TRIGGER IF EXISTS fail_activity_event_insert')
  }
}

await describe('task history', () => {
  test('creating a task records task.created', async () => {
    const task = await createTask('History create')
    const events = listTaskEvents(task.id)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('task.created')
    expect(events[0].summary).toBe('Task created')
  })

  test('updating title and status records semantic events', async () => {
    const task = await createTask('Before')
    await h.invoke('db:tasks:update', { id: task.id, title: 'After', status: 'in_progress' })

    const events = listTaskEvents(task.id)
    expect(events.map((event) => event.kind)).toEqual(['task.created', 'task.title_changed', 'task.status_changed'])
  })

  test('description history stores metadata only', async () => {
    const task = await createTask('Description task', { description: 'old text' })
    await h.invoke('db:tasks:update', { id: task.id, description: '# New body' })

    const events = listTaskEvents(task.id)
    const descriptionEvent = events.find((event) => event.kind === 'task.description_changed')
    expect(Boolean(descriptionEvent)).toBe(true)
    const payload = JSON.parse(descriptionEvent?.payload_json ?? '{}') as Record<string, unknown>
    expect(payload.beforeLength).toBe(8)
    expect(payload.afterLength).toBe(10)
    expect(payload.before).toBeUndefined()
  })

  test('setting tags records added and removed tag ids', async () => {
    const task = await createTask('Tag task')
    const tagA = h.invoke('db:tags:create', { projectId, name: 'Alpha' }) as { id: string }
    const tagB = h.invoke('db:tags:create', { projectId, name: 'Beta' }) as { id: string }

    await h.invoke('db:taskTags:setForTask', task.id, [tagA.id, tagB.id])
    await h.invoke('db:taskTags:setForTask', task.id, [tagB.id])

    const events = listTaskEvents(task.id).filter((event) => event.kind === 'task.tags_changed')
    expect(events).toHaveLength(2)

    const firstPayload = JSON.parse(events[0].payload_json ?? '{}') as Record<string, unknown>
    expect(firstPayload.addedTagIds).toEqual([tagA.id, tagB.id])
    expect(firstPayload.removedTagIds).toEqual([])

    const secondPayload = JSON.parse(events[1].payload_json ?? '{}') as Record<string, unknown>
    expect(secondPayload.addedTagIds).toEqual([])
    expect(secondPayload.removedTagIds).toEqual([tagA.id])
  })

  test('task creation rolls back when history insert fails', async () => {
    let failed = false

    try {
      await withFailingActivityEventInsert(() => h.invoke('db:tasks:create', { projectId, title: 'Rollback create' }))
    } catch {
      failed = true
    }

    expect(failed).toBe(true)

    const createdTask = h.db.prepare('SELECT id FROM tasks WHERE title = ?').get('Rollback create') as { id: string } | undefined
    expect(createdTask).toBeUndefined()
  })

  test('task update rolls back when history insert fails', async () => {
    const task = await createTask('Rollback update')

    let failed = false
    try {
      await withFailingActivityEventInsert(() => h.invoke('db:tasks:update', { id: task.id, title: 'Changed title', status: 'in_progress' }))
    } catch {
      failed = true
    }

    expect(failed).toBe(true)

    const row = h.db.prepare('SELECT title, status FROM tasks WHERE id = ?').get(task.id) as { title: string; status: string }
    expect(row.title).toBe('Rollback update')
    expect(row.status).toBe(task.status)

    const events = listTaskEvents(task.id)
    expect(events.map((event) => event.kind)).toEqual(['task.created'])
  })

  test('tag changes roll back when history insert fails', async () => {
    const task = await createTask('Rollback tags')
    const tag = h.invoke('db:tags:create', { projectId, name: 'RollbackTag' }) as { id: string }

    let failed = false
    try {
      await withFailingActivityEventInsert(() => h.invoke('db:taskTags:setForTask', task.id, [tag.id]))
    } catch {
      failed = true
    }

    expect(failed).toBe(true)

    const taskTags = h.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(task.id) as Array<{ tag_id: string }>
    expect(taskTags).toHaveLength(0)
    expect(listTaskEvents(task.id).map((event) => event.kind)).toEqual(['task.created'])
  })

  test('history:listForTask paginates deterministically with a cursor', async () => {
    const task = await createTask('Paged task')
    h.db.prepare('DELETE FROM activity_events WHERE task_id = ?').run(task.id)

    const insert = h.db.prepare(`
      INSERT INTO activity_events (
        id, entity_type, entity_id, project_id, task_id, kind, actor_type, source, summary, payload_json, created_at
      ) VALUES (?, 'task', ?, ?, ?, 'task.status_changed', 'user', 'task', ?, NULL, ?)
    `)
    const createdAt = '2026-04-01T10:00:00.000Z'
    insert.run('event-a', task.id, task.project_id, task.id, 'Event A', createdAt)
    insert.run('event-b', task.id, task.project_id, task.id, 'Event B', createdAt)
    insert.run('event-c', task.id, task.project_id, task.id, 'Event C', createdAt)

    const firstPage = await h.invoke('history:listForTask', task.id, { limit: 2 }) as {
      events: Array<{ id: string }>
      nextCursor: { createdAt: string; id: string } | null
    }
    expect(firstPage.events.map((event) => event.id)).toEqual(['event-c', 'event-b'])
    expect(firstPage.nextCursor).toEqual({ createdAt, id: 'event-b' })

    const secondPage = await h.invoke('history:listForTask', task.id, { limit: 2, before: firstPage.nextCursor }) as {
      events: Array<{ id: string }>
      nextCursor: { createdAt: string; id: string } | null
    }
    expect(secondPage.events.map((event) => event.id)).toEqual(['event-a'])
    expect(secondPage.nextCursor).toBeNull()
  })
})

h.cleanup()
process.exit(process.exitCode ?? 0)
