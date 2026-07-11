/**
 * REST: GET /api/tasks/:id/artifacts contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/artifacts/list.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerArtifactsListRoute } from './list.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const taskId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
  .run(taskId, projectId, 'Task')

const folderId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO artifact_folders (id, task_id, name, "order") VALUES (?, ?, ?, ?)')
  .run(folderId, taskId, 'Docs', 0)
const a1 = crypto.randomUUID()
const a2 = crypto.randomUUID()
const insertArtifact = h.db.prepare(
  'INSERT INTO task_artifacts (id, task_id, folder_id, title, "order") VALUES (?, ?, ?, ?, ?)'
)
insertArtifact.run(a1, taskId, null, 'notes.md', 1)
insertArtifact.run(a2, taskId, folderId, 'plan.md', 0)

const app = express()
app.use(express.json())
registerArtifactsListRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

type ListResponse = {
  ok: boolean
  data: { folders: { id: string; name: string }[]; artifacts: { id: string; title: string }[] }
}

await describe('GET /api/tasks/:id/artifacts', () => {
  test('happy: returns folders + artifacts ordered by "order"', async () => {
    const res = await rest.request<ListResponse>('GET', `/api/tasks/${taskId}/artifacts`)
    expect(res.status).toBe(200)
    expect(res.body.data.folders.map((f) => f.id)).toEqual([folderId])
    expect(res.body.data.artifacts.map((a) => a.id)).toEqual([a2, a1])
  })

  test('happy: empty task → empty lists', async () => {
    const emptyTask = crypto.randomUUID()
    h.db
      .prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
      .run(emptyTask, projectId, 'Empty')
    const res = await rest.request<ListResponse>('GET', `/api/tasks/${emptyTask}/artifacts`)
    expect(res.status).toBe(200)
    expect(res.body.data.folders).toEqual([])
    expect(res.body.data.artifacts).toEqual([])
  })

  test('404: unknown task', async () => {
    const res = await rest.request<ListResponse>('GET', '/api/tasks/ffffffff/artifacts')
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
