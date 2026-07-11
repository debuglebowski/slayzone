/**
 * REST: GET+POST+DELETE /api/tasks/:id/blockers contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/blockers.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerTaskBlockersRoutes } from './blockers.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const insertTask = h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
const a = crypto.randomUUID()
const b = crypto.randomUUID()
const c = crypto.randomUUID()
insertTask.run(a, projectId, 'A')
insertTask.run(b, projectId, 'B')
insertTask.run(c, projectId, 'C')

let notifyCount = 0
const app = express()
app.use(express.json())
registerTaskBlockersRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

type BlockersResponse = { ok: boolean; data: { id: string }[]; error?: string }

await describe('GET/POST/DELETE /api/tasks/:id/blockers', () => {
  test('GET: empty initially', async () => {
    const res = await rest.request<BlockersResponse>('GET', `/api/tasks/${a}/blockers`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  test('POST add: inserts dependency + returns blockers + notifies', async () => {
    notifyCount = 0
    const res = await rest.request<BlockersResponse>('POST', `/api/tasks/${a}/blockers`, {
      add: [b]
    })
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([b])
    expect(notifyCount).toBe(1)
    const dep = h.db
      .prepare('SELECT 1 AS x FROM task_dependencies WHERE task_id = ? AND blocks_task_id = ?')
      .get(b, a)
    expect(Boolean(dep)).toBe(true)
  })

  test('POST set: replaces existing blockers', async () => {
    const res = await rest.request<BlockersResponse>('POST', `/api/tasks/${a}/blockers`, {
      set: [c]
    })
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([c])
  })

  test('POST 400: self-block rejected', async () => {
    const res = await rest.request<BlockersResponse>('POST', `/api/tasks/${a}/blockers`, {
      add: [a]
    })
    expect(res.status).toBe(400)
  })

  test('POST 400: add and set together rejected', async () => {
    const res = await rest.request<BlockersResponse>('POST', `/api/tasks/${a}/blockers`, {
      add: [b],
      set: [c]
    })
    expect(res.status).toBe(400)
  })

  test('POST 404: unknown blocker ref', async () => {
    const res = await rest.request<BlockersResponse>('POST', `/api/tasks/${a}/blockers`, {
      add: ['ffffffff']
    })
    expect(res.status).toBe(404)
  })

  test('DELETE remove: removes one blocker', async () => {
    const res = await rest.request<BlockersResponse>('DELETE', `/api/tasks/${a}/blockers`, {
      remove: [c]
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  test('DELETE clear: removes all blockers', async () => {
    await rest.request('POST', `/api/tasks/${a}/blockers`, { set: [b, c] })
    const res = await rest.request<BlockersResponse>('DELETE', `/api/tasks/${a}/blockers`, {
      clear: true
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  test('DELETE 400: neither remove nor clear', async () => {
    const res = await rest.request<BlockersResponse>('DELETE', `/api/tasks/${a}/blockers`, {})
    expect(res.status).toBe(400)
  })

  test('404: unknown task', async () => {
    const res = await rest.request<BlockersResponse>('GET', '/api/tasks/ffffffff/blockers')
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
