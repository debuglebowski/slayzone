/**
 * REST: GET /api/projects contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/projects/list.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerProjectsListRoute } from './list.js'

const h = await createTestHarness()

const p1 = crypto.randomUUID()
const p2 = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(p1, 'Beta', '#000', '/tmp/beta')
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(p2, 'Alpha', '#000', '/tmp/alpha')

const insertTask = h.db.prepare(
  `INSERT INTO tasks (id, project_id, title, archived_at, deleted_at, is_temporary) VALUES (?, ?, ?, ?, ?, ?)`
)
insertTask.run(crypto.randomUUID(), p1, 'Visible 1', null, null, 0)
insertTask.run(crypto.randomUUID(), p1, 'Visible 2', null, null, 0)
insertTask.run(crypto.randomUUID(), p1, 'Archived', '2026-01-01', null, 0)
insertTask.run(crypto.randomUUID(), p1, 'Deleted', null, '2026-01-01', 0)
insertTask.run(crypto.randomUUID(), p1, 'Temp', null, null, 1)

const app = express()
app.use(express.json())
registerProjectsListRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

type ProjectsResponse = {
  ok: boolean
  data: { id: string; name: string; path: string; task_count: number }[]
}

await describe('GET /api/projects', () => {
  test('happy: name-ordered rows with visible-task counts', async () => {
    const res = await rest.request<ProjectsResponse>('GET', '/api/projects')
    expect(res.status).toBe(200)
    expect(res.body.data.map((p) => p.name)).toEqual(['Alpha', 'Beta'])
    expect(res.body.data.find((p) => p.id === p1)!.task_count).toBe(2)
    expect(res.body.data.find((p) => p.id === p2)!.task_count).toBe(0)
  })
})

await rest.close()
h.cleanup()
