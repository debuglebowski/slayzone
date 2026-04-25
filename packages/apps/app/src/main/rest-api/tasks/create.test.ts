/**
 * REST: POST /api/tasks contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/apps/app/src/main/rest-api/tasks/create.test.ts
 */
import express from 'express'
import { createTestHarness, test, expect, describe } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../../../../shared/test-utils/event-spy.js'
import { __ipcEmitCalls, __resetIpcEmitCalls } from '../../../../../../shared/test-utils/mock-electron.js'
import { taskEvents } from '@slayzone/task/main'
import { registerCreateTaskRoute } from './create.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')

let notifyCount = 0
const app = express()
app.use(express.json())
registerCreateTaskRoute(app, { db: h.db, notifyRenderer: () => { notifyCount++ } })
const rest = await mountRestApp(app)

await describe('POST /api/tasks', () => {
  test('happy: 200 + task payload + DB row inserted', async () => {
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:created')
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: { id: string; title: string; project_id: string } }>(
      'POST',
      '/api/tasks',
      { projectId, title: 'Hello' }
    )
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.title).toBe('Hello')
    expect(res.body.data.project_id).toBe(projectId)
    const row = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(res.body.data.id) as { title: string }
    expect(row.title).toBe('Hello')
    expect(spy.calls.length).toBe(1)
    expect((spy.calls[0].payload as { taskId: string }).taskId).toBe(res.body.data.id)
    const createEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:create:done')
    expect(createEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('400: missing required field projectId', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', { title: 'no project' })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('400: missing required field title', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', { projectId })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('400: empty body', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {})
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('400: priority out of range', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      projectId, title: 'bad', priority: 99
    })
    expect(res.status).toBe(400)
  })

  test('happy: explicit status + priority preserved', async () => {
    const res = await rest.request<{ ok: boolean; data: { status: string; priority: number } }>(
      'POST', '/api/tasks',
      { projectId, title: 'Custom', status: 'todo', priority: 1 }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('todo')
    expect(res.body.data.priority).toBe(1)
  })
})

await rest.close()
h.cleanup()
