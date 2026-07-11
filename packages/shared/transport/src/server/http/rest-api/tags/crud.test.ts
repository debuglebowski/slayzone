/**
 * REST: /api/tags CRUD contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tags/crud.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerTagsCrudRoutes } from './crud.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const seededTag = `44444444-${crypto.randomUUID().slice(9)}`
h.db
  .prepare('INSERT INTO tags (id, project_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)')
  .run(seededTag, projectId, 'Seed', '#123456', 0)

let notifyCount = 0
const app = express()
app.use(express.json())
registerTagsCrudRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

interface Tag {
  id: string
  project_id: string
  name: string
  color: string
  text_color: string
  sort_order: number
}

await describe('/api/tags CRUD', () => {
  test('GET: lists project tags (project by name)', async () => {
    const res = await rest.request<{ ok: boolean; data: Tag[] }>('GET', '/api/tags?project=Alpha')
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([seededTag])
  })

  test('GET 400: missing project', async () => {
    const res = await rest.request<{ ok: boolean }>('GET', '/api/tags')
    expect(res.status).toBe(400)
  })

  test('GET 404: unknown project', async () => {
    const res = await rest.request<{ ok: boolean }>('GET', '/api/tags?project=nope-zzz')
    expect(res.status).toBe(404)
  })

  test('POST: creates tag with CLI defaults + notifies', async () => {
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: Tag }>('POST', '/api/tags', {
      project: 'Alpha',
      name: 'Bug'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Bug')
    expect(res.body.data.color).toBe('#6366f1')
    expect(res.body.data.text_color).toBe('#ffffff')
    expect(res.body.data.sort_order).toBe(1)
    expect(notifyCount).toBe(1)
  })

  test('POST 400: missing name', async () => {
    const res = await rest.request<{ ok: boolean }>('POST', '/api/tags', { project: 'Alpha' })
    expect(res.status).toBe(400)
  })

  test('PATCH: updates fields by id prefix', async () => {
    const res = await rest.request<{ ok: boolean; data: Tag }>('PATCH', '/api/tags/44444444', {
      name: 'Renamed',
      color: '#abcdef'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Renamed')
    expect(res.body.data.color).toBe('#abcdef')
  })

  test('PATCH 404: unknown tag', async () => {
    const res = await rest.request<{ ok: boolean }>('PATCH', '/api/tags/ffffffff', { name: 'x' })
    expect(res.status).toBe(404)
  })

  test('DELETE: removes tag by id prefix', async () => {
    const res = await rest.request<{ ok: boolean; data: { id: string } }>(
      'DELETE',
      '/api/tags/44444444'
    )
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(seededTag)
    const row = h.db.prepare('SELECT 1 AS x FROM tags WHERE id = ?').get(seededTag)
    expect(Boolean(row)).toBe(false)
  })

  test('DELETE 404: unknown tag', async () => {
    const res = await rest.request<{ ok: boolean }>('DELETE', '/api/tags/ffffffff')
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
