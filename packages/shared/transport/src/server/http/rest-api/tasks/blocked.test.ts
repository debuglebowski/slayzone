/**
 * REST: /api/tasks/:id/blocked contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/blocked.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerTaskBlockedRoutes } from './blocked.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')

const taskId = `55555555-${crypto.randomUUID().slice(9)}`
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
  .run(taskId, projectId, 'Blockable', 'todo', 3, 0)

// A dependency blocker for context.
const blockerId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
  .run(blockerId, projectId, 'Blocker', 'todo', 3, 1)
h.db
  .prepare('INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)')
  .run(blockerId, taskId)

let notifyCount = 0
const app = express()
app.use(express.json())
registerTaskBlockedRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

interface BlockedState {
  is_blocked: boolean
  blocked_comment: string | null
  blockers: { id: string; title: string }[]
}
type Resp = { ok: boolean; data: BlockedState; error?: string }

await describe('/api/tasks/:id/blocked', () => {
  test('GET: initial state (not blocked) + shows dep blockers', async () => {
    const res = await rest.request<Resp>('GET', `/api/tasks/${taskId.slice(0, 8)}/blocked`)
    expect(res.status).toBe(200)
    expect(res.body.data.is_blocked).toBe(false)
    expect(res.body.data.blockers.map((b) => b.id)).toEqual([blockerId])
  })

  test('POST on: sets blocked + notifies', async () => {
    notifyCount = 0
    const res = await rest.request<Resp>('POST', `/api/tasks/${taskId}/blocked`, { on: true })
    expect(res.status).toBe(200)
    expect(res.body.data.is_blocked).toBe(true)
    expect(notifyCount).toBe(1)
  })

  test('POST comment: sets blocked + comment', async () => {
    const res = await rest.request<Resp>('POST', `/api/tasks/${taskId}/blocked`, {
      comment: 'waiting on API'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.is_blocked).toBe(true)
    expect(res.body.data.blocked_comment).toBe('waiting on API')
  })

  test('POST comment=null: clears comment only', async () => {
    const res = await rest.request<Resp>('POST', `/api/tasks/${taskId}/blocked`, {
      comment: null
    })
    expect(res.status).toBe(200)
    expect(res.body.data.blocked_comment).toBeNull()
    expect(res.body.data.is_blocked).toBe(true)
  })

  test('POST toggle: flips to unblocked (and clears comment)', async () => {
    const res = await rest.request<Resp>('POST', `/api/tasks/${taskId}/blocked`, { toggle: true })
    expect(res.status).toBe(200)
    expect(res.body.data.is_blocked).toBe(false)
    expect(res.body.data.blocked_comment).toBeNull()
  })

  test('POST off: idempotent clear', async () => {
    await rest.request<Resp>('POST', `/api/tasks/${taskId}/blocked`, { on: true })
    const res = await rest.request<Resp>('POST', `/api/tasks/${taskId}/blocked`, { off: true })
    expect(res.status).toBe(200)
    expect(res.body.data.is_blocked).toBe(false)
  })

  test('POST 400: bad comment type', async () => {
    const res = await rest.request<Resp>('POST', `/api/tasks/${taskId}/blocked`, { comment: 5 })
    expect(res.status).toBe(400)
  })

  test('GET 404: unknown task', async () => {
    const res = await rest.request<Resp>('GET', '/api/tasks/ffffffff/blocked')
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
