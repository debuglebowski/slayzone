/**
 * REST: GET /api/tasks contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/list.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerListTasksRoute } from './list.js'

const h = await createTestHarness()

const p1 = crypto.randomUUID()
const p2 = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(p1, 'Alpha', '#000', '/tmp/alpha')
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(p2, 'Beta', '#000', '/tmp/beta')

const insertTask = h.db.prepare(
  `INSERT INTO tasks (id, project_id, title, status, "order", archived_at, deleted_at, is_temporary)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
)
const t1 = crypto.randomUUID()
const t2 = crypto.randomUUID()
const t3 = crypto.randomUUID()
insertTask.run(t1, p1, 'Alpha in progress', 'in_progress', 1, null, null, 0)
insertTask.run(t2, p1, 'Alpha done', 'done', 2, null, null, 0)
insertTask.run(t3, p2, 'Beta todo', 'todo', 0, null, null, 0)
// Excluded rows: archived, deleted, temporary.
insertTask.run(crypto.randomUUID(), p1, 'Archived', 'todo', 3, '2026-01-01', null, 0)
insertTask.run(crypto.randomUUID(), p1, 'Deleted', 'todo', 4, null, '2026-01-01', 0)
insertTask.run(crypto.randomUUID(), p1, 'Temp', 'todo', 5, null, null, 1)

// Tag on t1 + a dependency making t3 blocked.
const tagId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tags (id, project_id, name, color) VALUES (?, ?, ?, ?)')
  .run(tagId, p1, 'Bug', '#f00')
h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(t1, tagId)
h.db
  .prepare('INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)')
  .run(t1, t3)

const app = express()
app.use(express.json())
registerListTasksRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

interface TaskJson {
  id: string
  title: string
  status: string
  project_name: string
  is_blocked: boolean
  tags: string[]
}
type ListResponse = { ok: boolean; data: TaskJson[] }

await describe('GET /api/tasks', () => {
  test('happy: lists visible tasks ordered by "order", enriched with tags + is_blocked', async () => {
    const res = await rest.request<ListResponse>('GET', '/api/tasks')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.map((t) => t.id)).toEqual([t3, t1, t2])
    const first = res.body.data.find((t) => t.id === t1)!
    expect(first.project_name).toBe('Alpha')
    expect(first.tags).toEqual(['Bug'])
    expect(first.is_blocked).toBe(false)
    expect(res.body.data.find((t) => t.id === t3)!.is_blocked).toBe(true)
  })

  test('filter: project by case-insensitive name substring', async () => {
    const res = await rest.request<ListResponse>('GET', '/api/tasks?project=alph')
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([t1, t2])
  })

  test('filter: status', async () => {
    const res = await rest.request<ListResponse>('GET', '/api/tasks?status=in_progress')
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([t1])
  })

  test('filter: done returns completed tasks only', async () => {
    const res = await rest.request<ListResponse>('GET', '/api/tasks?done=1')
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([t2])
  })

  test('limit caps result count', async () => {
    const res = await rest.request<ListResponse>('GET', '/api/tasks?limit=1')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  test('400: invalid limit', async () => {
    const res = await rest.request<{ ok: boolean }>('GET', '/api/tasks?limit=abc')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })
})

await rest.close()
h.cleanup()
