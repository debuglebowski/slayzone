/**
 * REST: GET /api/tasks/:id/progress contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/progress.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerTaskProgressRoute } from './progress.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const taskId = `33333333-${crypto.randomUUID().slice(9)}`
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, progress) VALUES (?, ?, ?, ?)')
  .run(taskId, projectId, 'Task', 42)

const app = express()
app.use(express.json())
registerTaskProgressRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

type ProgressResponse = { ok: boolean; data: { id: string; progress: number } }

await describe('GET /api/tasks/:id/progress', () => {
  test('happy: returns progress by full id', async () => {
    const res = await rest.request<ProgressResponse>('GET', `/api/tasks/${taskId}/progress`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: taskId, progress: 42 })
  })

  test('happy: id prefix resolves', async () => {
    const res = await rest.request<ProgressResponse>('GET', '/api/tasks/33333333/progress')
    expect(res.status).toBe(200)
    expect(res.body.data.progress).toBe(42)
  })

  test('404: unknown task', async () => {
    const res = await rest.request<ProgressResponse>('GET', '/api/tasks/ffffffff/progress')
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
