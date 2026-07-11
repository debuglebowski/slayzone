/**
 * REST: GET /api/tasks/search contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/search.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerSearchTasksRoute } from './search.js'

const h = await createTestHarness()

const p1 = crypto.randomUUID()
const p2 = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(p1, 'Alpha', '#000', '/tmp/a')
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(p2, 'Beta', '#000', '/tmp/b')

const insertTask = h.db.prepare(
  `INSERT INTO tasks (id, project_id, title, description, deleted_at, is_temporary) VALUES (?, ?, ?, ?, ?, ?)`
)
const titleHit = crypto.randomUUID()
const descHit = crypto.randomUUID()
const otherProject = crypto.randomUUID()
insertTask.run(titleHit, p1, 'Fix LOGIN bug', null, null, 0)
insertTask.run(descHit, p1, 'Unrelated', 'the login flow is broken', null, 0)
insertTask.run(otherProject, p2, 'login page', null, null, 0)
insertTask.run(crypto.randomUUID(), p1, 'login deleted', null, '2026-01-01', 0)
insertTask.run(crypto.randomUUID(), p1, 'login temp', null, null, 1)

const app = express()
app.use(express.json())
registerSearchTasksRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

type SearchResponse = { ok: boolean; data: { id: string; title: string }[] }

await describe('GET /api/tasks/search', () => {
  test('happy: case-insensitive title + description match, deleted/temp excluded', async () => {
    const res = await rest.request<SearchResponse>('GET', '/api/tasks/search?q=login')
    expect(res.status).toBe(200)
    const ids = res.body.data.map((t) => t.id).sort()
    expect(ids).toEqual([titleHit, descHit, otherProject].sort())
  })

  test('filter: project narrows results', async () => {
    const res = await rest.request<SearchResponse>('GET', '/api/tasks/search?q=login&project=Beta')
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([otherProject])
  })

  test('limit caps result count', async () => {
    const res = await rest.request<SearchResponse>('GET', '/api/tasks/search?q=login&limit=1')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  test('400: missing q', async () => {
    const res = await rest.request<{ ok: boolean }>('GET', '/api/tasks/search')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })
})

await rest.close()
h.cleanup()
