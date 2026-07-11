/**
 * REST: /api/templates CRUD contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/templates/crud.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerTemplatesCrudRoutes } from './crud.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')

let notifyCount = 0
const app = express()
app.use(express.json())
registerTemplatesCrudRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

interface Template {
  id: string
  project_id: string
  name: string
  default_priority: number | null
  default_status: string | null
  is_default: boolean
}
type One = { ok: boolean; data: Template; error?: string }
type Many = { ok: boolean; data: Template[] }

let firstId = ''
let secondId = ''

await describe('/api/templates CRUD', () => {
  test('POST: creates template (project by name) + notifies', async () => {
    notifyCount = 0
    const res = await rest.request<One>('POST', '/api/templates', {
      project: 'Alpha',
      name: 'Default flow',
      priority: 2,
      status: 'todo',
      isDefault: true
    })
    expect(res.status).toBe(200)
    expect(res.body.data.project_id).toBe(projectId)
    expect(res.body.data.default_priority).toBe(2)
    expect(res.body.data.default_status).toBe('todo')
    expect(res.body.data.is_default).toBe(true)
    expect(notifyCount).toBe(1)
    firstId = res.body.data.id
  })

  test('POST: second default clears the first (store invariant)', async () => {
    const res = await rest.request<One>('POST', '/api/templates', {
      project: 'Alpha',
      name: 'New default',
      isDefault: true
    })
    expect(res.status).toBe(200)
    secondId = res.body.data.id
    const first = h.db
      .prepare('SELECT is_default FROM task_templates WHERE id = ?')
      .get(firstId) as { is_default: number }
    expect(first.is_default).toBe(0)
  })

  test('POST 400: priority out of range', async () => {
    const res = await rest.request<One>('POST', '/api/templates', {
      project: 'Alpha',
      name: 'bad',
      priority: 7
    })
    expect(res.status).toBe(400)
  })

  test('POST 400: missing name', async () => {
    const res = await rest.request<One>('POST', '/api/templates', { project: 'Alpha' })
    expect(res.status).toBe(400)
  })

  test('GET list: ordered templates for project', async () => {
    const res = await rest.request<Many>('GET', '/api/templates?project=Alpha')
    expect(res.status).toBe(200)
    expect(res.body.data.map((t) => t.id)).toEqual([firstId, secondId])
  })

  test('GET list 400: missing project', async () => {
    const res = await rest.request<Many>('GET', '/api/templates')
    expect(res.status).toBe(400)
  })

  test('GET :id by prefix', async () => {
    const res = await rest.request<One>('GET', `/api/templates/${firstId.slice(0, 8)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(firstId)
  })

  test('GET :id 404: unknown', async () => {
    const res = await rest.request<One>('GET', '/api/templates/ffffffff')
    expect(res.status).toBe(404)
  })

  test('PATCH: updates fields', async () => {
    const res = await rest.request<One>('PATCH', `/api/templates/${firstId}`, {
      name: 'Renamed',
      priority: 5
    })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Renamed')
    expect(res.body.data.default_priority).toBe(5)
  })

  test('PATCH 400: empty body', async () => {
    const res = await rest.request<One>('PATCH', `/api/templates/${firstId}`, {})
    expect(res.status).toBe(400)
  })

  test('DELETE: removes template', async () => {
    const res = await rest.request<One>('DELETE', `/api/templates/${firstId}`)
    expect(res.status).toBe(200)
    const row = h.db.prepare('SELECT 1 AS x FROM task_templates WHERE id = ?').get(firstId)
    expect(Boolean(row)).toBe(false)
  })

  test('DELETE 404: unknown', async () => {
    const res = await rest.request<One>('DELETE', '/api/templates/ffffffff')
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
