/**
 * REST: GET /api/tasks/:id/blocking contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/tasks/blocking.test.ts
 */
import express from 'express'
import { describe, test, expect, afterAll } from 'vitest'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { registerTaskBlockingRoute } from './blocking.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const insertTask = h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
const blocker = crypto.randomUUID()
const blocked = crypto.randomUUID()
insertTask.run(blocker, projectId, 'Blocker')
insertTask.run(blocked, projectId, 'Blocked')
h.db
  .prepare('INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)')
  .run(blocker, blocked)

const app = express()
app.use(express.json())
registerTaskBlockingRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

type BlockingResponse = { ok: boolean; data: { id: string; title: string }[] }

describe('GET /api/tasks/:id/blocking', () => {
  test('happy: returns tasks this task blocks', async () => {
    const res = await rest.request<BlockingResponse>('GET', `/api/tasks/${blocker}/blocking`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([blocked])
  })

  test('happy: empty when task blocks nothing', async () => {
    const res = await rest.request<BlockingResponse>('GET', `/api/tasks/${blocked}/blocking`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  test('404: unknown task', async () => {
    const res = await rest.request<BlockingResponse>('GET', '/api/tasks/ffffffff/blocking')
    expect(res.status).toBe(404)
  })
})

afterAll(async () => {
  await rest.close()
  h.cleanup()
})
