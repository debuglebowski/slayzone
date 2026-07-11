/**
 * REST: GET /api/tasks/:id contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/get.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerGetTaskRoute } from './get.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')

const insertTask = h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
const taskId = `11111111-${crypto.randomUUID().slice(9)}`
const blockerId = crypto.randomUUID()
const blockedId = crypto.randomUUID()
insertTask.run(taskId, projectId, 'Main task')
insertTask.run(blockerId, projectId, 'Blocker task')
insertTask.run(blockedId, projectId, 'Blocked task')
// Ambiguous-prefix pair.
insertTask.run(`22222222-aaaa-${crypto.randomUUID().slice(14)}`, projectId, 'Amb 1')
insertTask.run(`22222222-bbbb-${crypto.randomUUID().slice(14)}`, projectId, 'Amb 2')

const tagId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tags (id, project_id, name, color) VALUES (?, ?, ?, ?)')
  .run(tagId, projectId, 'Bug', '#f00')
h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tagId)
const insertDep = h.db.prepare(
  'INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)'
)
insertDep.run(blockerId, taskId) // blocker blocks main
insertDep.run(taskId, blockedId) // main blocks blocked

const app = express()
app.use(express.json())
registerGetTaskRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

interface Detail {
  ok: boolean
  data: {
    id: string
    title: string
    project_name: string
    tags: string[]
    blockers: { id: string; title: string }[]
    blocking: { id: string; title: string }[]
  }
  error?: string
}

await describe('GET /api/tasks/:id', () => {
  test('happy: full id returns task + project_name + tags + blockers + blocking', async () => {
    const res = await rest.request<Detail>('GET', `/api/tasks/${taskId}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(taskId)
    expect(res.body.data.title).toBe('Main task')
    expect(res.body.data.project_name).toBe('Alpha')
    expect(res.body.data.tags).toEqual(['Bug'])
    expect(res.body.data.blockers.map((b) => b.id)).toEqual([blockerId])
    expect(res.body.data.blocking.map((b) => b.id)).toEqual([blockedId])
  })

  test('happy: unique id prefix resolves', async () => {
    const res = await rest.request<Detail>('GET', '/api/tasks/11111111')
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(taskId)
  })

  test('404: unknown id', async () => {
    const res = await rest.request<Detail>('GET', '/api/tasks/ffffffff')
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
  })

  test('400: ambiguous prefix', async () => {
    const res = await rest.request<Detail>('GET', '/api/tasks/22222222')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })
})

await rest.close()
h.cleanup()
