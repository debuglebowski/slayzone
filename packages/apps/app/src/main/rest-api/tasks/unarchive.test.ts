/**
 * REST: POST /api/tasks/:id/unarchive contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/rest-api/tasks/unarchive.test.ts
 */
import express from 'express'
import { createTestHarness, test, expect, describe } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerUnarchiveTaskRoute } from './unarchive.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const app = express()
app.use(express.json())
registerUnarchiveTaskRoute(app, { db: h.db, notifyRenderer: () => { notifyCount++ } })
const rest = await mountRestApp(app)

function seedArchivedTask(): string {
  const id = crypto.randomUUID()
  h.db.prepare(`INSERT INTO tasks (id, project_id, title, status, priority, "order", archived_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

await describe('POST /api/tasks/:id/unarchive', () => {
  test('happy: 200 + archived_at cleared + dual-emit', async () => {
    const id = seedArchivedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:unarchived')
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: { id: string; archived_at: string | null } }>('POST', `/api/tasks/${id}/unarchive`)
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.archived_at).toBeNull()
    const row = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as { archived_at: string | null }
    expect(row.archived_at).toBeNull()
    expect(spy.calls.length).toBe(1)
    expect((spy.calls[0].payload as { taskId: string }).taskId).toBe(id)
    const unarchiveEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:unarchive:done')
    expect(unarchiveEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('400: malformed id (Zod uuid validation)', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks/not-a-uuid/unarchive')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('404: unarchive non-existent task', async () => {
    const ghost = crypto.randomUUID()
    const res = await rest.request<{ ok: boolean; error: string }>('POST', `/api/tasks/${ghost}/unarchive`)
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
  })
})

await rest.close()
h.cleanup()
