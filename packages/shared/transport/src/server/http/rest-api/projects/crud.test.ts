/**
 * REST: /api/projects CRUD contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/projects/crud.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerProjectsCrudRoutes } from './crud.js'

const h = await createTestHarness()

const existingId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(existingId, 'Existing', '#000000', '/tmp/existing')

let notifyCount = 0
const app = express()
app.use(express.json())
registerProjectsCrudRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

interface Project {
  id: string
  name: string
  color: string
  path: string | null
}
type OneResponse = { ok: boolean; data: Project; error?: string }

let createdId = ''

await describe('/api/projects CRUD', () => {
  test('POST: creates a project with defaults + notifies', async () => {
    notifyCount = 0
    const res = await rest.request<OneResponse>('POST', '/api/projects', {
      name: 'Fresh',
      path: '/tmp/fresh'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Fresh')
    expect(res.body.data.color).toBe('#3b82f6')
    expect(res.body.data.path).toBe('/tmp/fresh')
    expect(notifyCount).toBe(1)
    createdId = res.body.data.id
    const row = h.db.prepare('SELECT name FROM projects WHERE id = ?').get(createdId) as {
      name: string
    }
    expect(row.name).toBe('Fresh')
  })

  test('POST 400: missing name', async () => {
    const res = await rest.request<OneResponse>('POST', '/api/projects', { color: '#abcdef' })
    expect(res.status).toBe(400)
  })

  test('POST 400: invalid color', async () => {
    const res = await rest.request<OneResponse>('POST', '/api/projects', {
      name: 'BadColor',
      color: 'not-a-hex'
    })
    expect(res.status).toBe(400)
  })

  test('PATCH: updates name + color by name substring', async () => {
    const res = await rest.request<OneResponse>('PATCH', '/api/projects/Existing', {
      name: 'Renamed',
      color: '#ff0000'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(existingId)
    expect(res.body.data.name).toBe('Renamed')
    expect(res.body.data.color).toBe('#ff0000')
  })

  test('PATCH: clears path with null', async () => {
    const res = await rest.request<OneResponse>('PATCH', `/api/projects/${existingId}`, {
      path: null
    })
    expect(res.status).toBe(200)
    expect(res.body.data.path).toBeNull()
  })

  test('PATCH 400: no fields', async () => {
    const res = await rest.request<OneResponse>('PATCH', `/api/projects/${existingId}`, {})
    expect(res.status).toBe(400)
  })

  test('PATCH 404: unknown project', async () => {
    const res = await rest.request<OneResponse>('PATCH', '/api/projects/definitely-not-a-project', {
      name: 'x'
    })
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
