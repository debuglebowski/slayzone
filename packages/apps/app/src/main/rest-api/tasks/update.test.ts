/**
 * REST: PATCH /api/tasks/:id contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/rest-api/tasks/update.test.ts
 */
import express from 'express'
import { createTestHarness, test, expect, describe } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerUpdateTaskRoute } from './update.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const app = express()
app.use(express.json())
registerUpdateTaskRoute(app, { db: h.db, notifyRenderer: () => { notifyCount++ } })
const rest = await mountRestApp(app)

function seedTask(extra: Record<string, unknown> = {}): string {
  const id = crypto.randomUUID()
  const status = (extra.status as string) ?? 'todo'
  h.db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, 'T', status, 3, 0)
  return id
}

await describe('PATCH /api/tasks/:id', () => {
  test('happy: 200 updates title; emits dual signals', async () => {
    const id = seedTask()
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:updated')
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: { title: string } }>('PATCH', `/api/tasks/${id}`, { title: 'Renamed' })
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.title).toBe('Renamed')
    const row = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(id) as { title: string }
    expect(row.title).toBe('Renamed')
    expect(spy.calls.length).toBe(1)
    expect((spy.calls[0].payload as { taskId: string }).taskId).toBe(id)
    const updateEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:update:done')
    expect(updateEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('side-effect: oldStatus carried in payload when status changes', async () => {
    const id = seedTask({ status: 'todo' })
    const spy = spyTaskEvents(taskEvents, 'task:updated')
    await rest.request('PATCH', `/api/tasks/${id}`, { status: 'in_progress' })
    spy.stop()
    expect(spy.calls.length).toBeGreaterThanOrEqual(1)
    const payload = spy.calls[0].payload as { oldStatus?: string }
    expect(payload.oldStatus).toBe('todo')
  })

  test('400: malformed id (not a uuid)', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', '/api/tasks/not-a-uuid', { title: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('400: priority out of range', async () => {
    const id = seedTask()
    const res = await rest.request('PATCH', `/api/tasks/${id}`, { priority: 99 })
    expect(res.status).toBe(400)
  })

  test('400: unknown field rejected (strict schema)', async () => {
    const id = seedTask()
    const res = await rest.request('PATCH', `/api/tasks/${id}`, { wat: 'unknown' })
    expect(res.status).toBe(400)
  })

  test('404: update non-existent task', async () => {
    const ghost = crypto.randomUUID()
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${ghost}`, { title: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
  })

  test('500: invalid reparent throws (cyclic)', async () => {
    const id = seedTask()
    const res = await rest.request<{ ok: boolean; error: string }>('PATCH', `/api/tasks/${id}`, { parentId: id })
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
  })
})

await rest.close()
h.cleanup()
