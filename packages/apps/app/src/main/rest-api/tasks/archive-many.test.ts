/**
 * REST: POST /api/tasks/archive-many contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/rest-api/tasks/archive-many.test.ts
 */
import express from 'express'
import { createTestHarness, test, expect, describe } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerArchiveManyTaskRoute } from './archive-many.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const app = express()
app.use(express.json())
registerArchiveManyTaskRoute(app, { db: h.db, notifyRenderer: () => { notifyCount++ } })
const rest = await mountRestApp(app)

function seedTask(): string {
  const id = crypto.randomUUID()
  h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

await describe('POST /api/tasks/archive-many', () => {
  test('happy: 200 + archives all ids + per-id dual emits', async () => {
    const ids = [seedTask(), seedTask(), seedTask()]
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: null }>('POST', '/api/tasks/archive-many', { ids })
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    for (const id of ids) {
      const row = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as { archived_at: string | null }
      expect(row.archived_at !== null).toBe(true)
    }
    expect(spy.calls.length).toBe(ids.length)
    const archiveEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:archive:done')
    expect(archiveEmits.length).toBeGreaterThanOrEqual(ids.length)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('happy: empty ids array is a no-op success', async () => {
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    const res = await rest.request<{ ok: boolean }>('POST', '/api/tasks/archive-many', { ids: [] })
    spy.stop()
    expect(res.status).toBe(200)
    expect(spy.calls.length).toBe(0)
    const archiveEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:archive:done')
    expect(archiveEmits.length).toBe(0)
  })

  test('400: missing ids field', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks/archive-many', {})
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('400: ids is not an array', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks/archive-many', { ids: 'oops' })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('cascade: archives sub-tasks of the given parents', async () => {
    const parent = seedTask()
    const child = crypto.randomUUID()
    h.db.prepare('INSERT INTO tasks (id, project_id, parent_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(child, projectId, parent, 'C', 'todo', 3, 1)
    await rest.request('POST', '/api/tasks/archive-many', { ids: [parent] })
    const childRow = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(child) as { archived_at: string | null }
    expect(childRow.archived_at !== null).toBe(true)
  })
})

await rest.close()
h.cleanup()
