/**
 * REST: DELETE /api/tasks/:id contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/rest-api/tasks/delete.test.ts
 */
import express from 'express'
import { createTestHarness, test, expect, describe } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerDeleteTaskRoute } from './delete.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const app = express()
app.use(express.json())
registerDeleteTaskRoute(app, { db: h.db, notifyRenderer: () => { notifyCount++ } })
const rest = await mountRestApp(app)

function seedTask(): string {
  const id = crypto.randomUUID()
  h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

await describe('DELETE /api/tasks/:id', () => {
  test('happy: 200 + soft-deletes (deleted_at set) + taskEvents emits', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:deleted')
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: boolean }>('DELETE', `/api/tasks/${id}`)
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data).toBe(true)
    const row = h.db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as { deleted_at: string | null }
    expect(row.deleted_at !== null).toBe(true)
    expect(spy.calls.length).toBe(1)
    expect((spy.calls[0].payload as { taskId: string }).taskId).toBe(id)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('emits db:tasks:delete:done (dual-emit invariant)', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    await rest.request('DELETE', `/api/tasks/${id}`)
    const deleteEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:delete:done')
    expect(deleteEmits.length).toBeGreaterThanOrEqual(1)
    expect(deleteEmits[0][2]).toBe(id)
  })

  test('400: malformed id (Zod uuid validation)', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('DELETE', '/api/tasks/not-a-uuid')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('404: delete non-existent task', async () => {
    const ghost = crypto.randomUUID()
    const res = await rest.request<{ ok: boolean; error: string }>('DELETE', `/api/tasks/${ghost}`)
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
  })

  test('blocked: returns linked_to_provider + does NOT emit', async () => {
    const id = seedTask()
    const connId = crypto.randomUUID()
    h.db.prepare(`INSERT INTO integration_connections (id, provider, credential_ref) VALUES (?, 'github', 'ref')`).run(connId)
    h.db.prepare(`INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, task_id) VALUES (?, 'github', ?, 'issue', '42', '42', ?)`)
      .run(crypto.randomUUID(), connId, id)
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:deleted')
    const res = await rest.request<{ ok: boolean; data: { blocked: true; reason: string } }>('DELETE', `/api/tasks/${id}`)
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect((res.body.data as { blocked: boolean }).blocked).toBe(true)
    expect((res.body.data as { reason: string }).reason).toBe('linked_to_provider')
    const row = h.db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as { deleted_at: string | null }
    expect(row.deleted_at).toBeNull()
    expect(spy.calls.length).toBe(0)
  })
})

await rest.close()
h.cleanup()
