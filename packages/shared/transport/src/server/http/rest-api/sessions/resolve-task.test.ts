/**
 * REST: GET /api/session/:sessionId/task contract tests (pool session→task).
 * Run with: pnpm tsx --loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/sessions/resolve-task.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerResolveSessionTaskRoute } from './resolve-task.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'P', '#000', '/tmp/p')
const taskId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
  .run(taskId, projectId, 'T', 'todo', 3, 0)

function seedSession(id: string, boundTaskId: string | null, status: string): void {
  h.db
    .prepare(
      `INSERT INTO agent_sessions (id, mode, task_id, origin, status, created_at)
       VALUES (?, 'claude-code', ?, 'slay-spawned-fresh', ?, 0)`
    )
    .run(id, boundTaskId, status)
}

const app = express()
app.use(express.json())
registerResolveSessionTaskRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

await describe('GET /api/session/:sessionId/task', () => {
  test('bound session → returns its task id', async () => {
    seedSession('S-bound', taskId, 'bound')
    const res = await rest.request<{ taskId: string | null }>('GET', '/api/session/S-bound/task')
    expect(res.status).toBe(200)
    expect(res.body.taskId).toBe(taskId)
  })

  test('pooled session (no task) → null', async () => {
    seedSession('S-pooled', null, 'pooled')
    const res = await rest.request<{ taskId: string | null }>('GET', '/api/session/S-pooled/task')
    expect(res.status).toBe(200)
    expect(res.body.taskId).toBe(null)
  })

  test('unknown session → null (not an error)', async () => {
    const res = await rest.request<{ taskId: string | null }>('GET', '/api/session/does-not-exist/task')
    expect(res.status).toBe(200)
    expect(res.body.taskId).toBe(null)
  })
})

await rest.close()
h.cleanup()
