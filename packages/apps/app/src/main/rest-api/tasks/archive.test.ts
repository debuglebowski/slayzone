/**
 * REST: POST /api/tasks/:id/archive contract tests.
 * Run with: pnpm tsx --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/rest-api/tasks/archive.test.ts
 */
import express from 'express'
import { createTestHarness, test, expect, describe } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerArchiveTaskRoute } from './archive.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const app = express()
app.use(express.json())
registerArchiveTaskRoute(app, { db: h.db, notifyRenderer: () => { notifyCount++ } })
const rest = await mountRestApp(app)

function seedTask(): string {
  const id = crypto.randomUUID()
  h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, 'T', 'todo', 3, 0)
  return id
}

await describe('POST /api/tasks/:id/archive', () => {
  test('happy: 200 + archived payload + DB archived_at set', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: { id: string; archived_at: string | null } }>('POST', `/api/tasks/${id}/archive`)
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.id).toBe(id)
    expect(res.body.data.archived_at !== null).toBe(true)
    const row = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as { archived_at: string | null }
    expect(row.archived_at !== null).toBe(true)
    expect(spy.calls.length).toBe(1)
    expect(spy.calls[0].event).toBe('task:archived')
    expect((spy.calls[0].payload as { taskId: string }).taskId).toBe(id)
    const archiveEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:archive:done')
    expect(archiveEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('400: malformed id (Zod uuid validation)', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks/not-a-uuid/archive')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('404: archive non-existent task', async () => {
    const ghost = crypto.randomUUID()
    const res = await rest.request<{ ok: boolean; error: string }>('POST', `/api/tasks/${ghost}/archive`)
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
  })

  test('side-effect: dual-emit invariant for archive (taskEvents + ipcMain)', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:archived')
    await rest.request('POST', `/api/tasks/${id}/archive`)
    spy.stop()
    expect(spy.calls.length).toBe(1)
    const archiveEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:archive:done')
    expect(archiveEmits.length).toBeGreaterThanOrEqual(1)
  })
})

await rest.close()
h.cleanup()
