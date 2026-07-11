/**
 * REST: POST+DELETE /api/tasks/:id/tags contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/tags.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerTaskTagsRoutes } from './tags.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
const otherProjectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(otherProjectId, 'Beta', '#000', '/tmp/beta')

const taskId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
  .run(taskId, projectId, 'Task')

const insertTag = h.db.prepare(
  'INSERT INTO tags (id, project_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)'
)
insertTag.run(crypto.randomUUID(), projectId, 'Bug', '#f00', 0)
insertTag.run(crypto.randomUUID(), projectId, 'Feat', '#0f0', 1)
insertTag.run(crypto.randomUUID(), otherProjectId, 'Elsewhere', '#00f', 0)

let notifyCount = 0
const app = express()
app.use(express.json())
registerTaskTagsRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

type TagsResponse = { ok: boolean; data: string[]; error?: string }

await describe('POST/DELETE /api/tasks/:id/tags', () => {
  test('POST add: case-insensitive name match + notifies', async () => {
    notifyCount = 0
    const res = await rest.request<TagsResponse>('POST', `/api/tasks/${taskId}/tags`, {
      add: 'bug'
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(['Bug'])
    expect(notifyCount).toBe(1)
  })

  test('POST set: replaces assignments (ordered by sort_order)', async () => {
    const res = await rest.request<TagsResponse>('POST', `/api/tasks/${taskId}/tags`, {
      set: ['Feat', 'Bug']
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(['Bug', 'Feat'])
  })

  test('POST 404: unknown tag name', async () => {
    const res = await rest.request<TagsResponse>('POST', `/api/tasks/${taskId}/tags`, {
      add: 'nope'
    })
    expect(res.status).toBe(404)
  })

  test("POST 404: tag from another project doesn't resolve", async () => {
    const res = await rest.request<TagsResponse>('POST', `/api/tasks/${taskId}/tags`, {
      add: 'Elsewhere'
    })
    expect(res.status).toBe(404)
  })

  test('POST 400: add and set together rejected', async () => {
    const res = await rest.request<TagsResponse>('POST', `/api/tasks/${taskId}/tags`, {
      add: 'Bug',
      set: ['Feat']
    })
    expect(res.status).toBe(400)
  })

  test('DELETE remove: removes one tag', async () => {
    const res = await rest.request<TagsResponse>('DELETE', `/api/tasks/${taskId}/tags`, {
      remove: 'Bug'
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(['Feat'])
  })

  test('DELETE clear: removes all tags', async () => {
    const res = await rest.request<TagsResponse>('DELETE', `/api/tasks/${taskId}/tags`, {
      clear: true
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  test('DELETE 400: neither remove nor clear', async () => {
    const res = await rest.request<TagsResponse>('DELETE', `/api/tasks/${taskId}/tags`, {})
    expect(res.status).toBe(400)
  })

  test('404: unknown task', async () => {
    const res = await rest.request<TagsResponse>('POST', '/api/tasks/ffffffff/tags', {
      add: 'Bug'
    })
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
