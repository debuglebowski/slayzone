/**
 * REST: /api/automations CRUD contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/automations/crud.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerAutomationsCrudRoutes } from './crud.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')

let notifyCount = 0
const app = express()
app.use(express.json())
registerAutomationsCrudRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

interface Automation {
  id: string
  project_id: string
  name: string
  enabled: boolean
  trigger_config: { type: string }
  actions: { type: string }[]
}
type One = { ok: boolean; data: Automation; error?: string }
type Many = { ok: boolean; data: Automation[] }

let createdId = ''

await describe('/api/automations CRUD', () => {
  test('POST: creates automation (project by name) with parsed JSON shape + notifies', async () => {
    notifyCount = 0
    const res = await rest.request<One>('POST', '/api/automations', {
      project: 'Alpha',
      name: 'On done',
      trigger_config: { type: 'task_status_change', params: { toStatus: 'done' } },
      actions: [{ type: 'run_command', params: { command: 'echo hi' } }]
    })
    expect(res.status).toBe(200)
    expect(res.body.data.project_id).toBe(projectId)
    expect(res.body.data.enabled).toBe(true)
    expect(res.body.data.trigger_config.type).toBe('task_status_change')
    expect(res.body.data.actions).toHaveLength(1)
    expect(notifyCount).toBe(1)
    createdId = res.body.data.id
  })

  test('POST 400: missing trigger_config/actions', async () => {
    const res = await rest.request<One>('POST', '/api/automations', {
      project: 'Alpha',
      name: 'bad'
    })
    expect(res.status).toBe(400)
  })

  test('POST 404: unknown project', async () => {
    const res = await rest.request<One>('POST', '/api/automations', {
      project: 'zzz-nope',
      name: 'x',
      trigger_config: { type: 'manual', params: {} },
      actions: [{ type: 'run_command', params: { command: 'true' } }]
    })
    expect(res.status).toBe(404)
  })

  test('GET list: automations for project', async () => {
    const res = await rest.request<Many>('GET', '/api/automations?project=Alpha')
    expect(res.status).toBe(200)
    expect(res.body.data.map((a) => a.id)).toEqual([createdId])
  })

  test('GET list 400: missing project', async () => {
    const res = await rest.request<Many>('GET', '/api/automations')
    expect(res.status).toBe(400)
  })

  test('GET :id by prefix', async () => {
    const res = await rest.request<One>('GET', `/api/automations/${createdId.slice(0, 8)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(createdId)
  })

  test('GET :id 404: unknown', async () => {
    const res = await rest.request<One>('GET', '/api/automations/ffffffff')
    expect(res.status).toBe(404)
  })

  test('GET :id/runs: newest-first execution history', async () => {
    const runId = crypto.randomUUID()
    h.db
      .prepare(
        `INSERT INTO automation_runs (id, automation_id, status, started_at) VALUES (?, ?, ?, ?)`
      )
      .run(runId, createdId, 'success', new Date().toISOString())
    const res = await rest.request<{ ok: boolean; data: { id: string; status: string }[] }>(
      'GET',
      `/api/automations/${createdId.slice(0, 8)}/runs`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.map((r) => r.id)).toEqual([runId])
  })

  test('GET :id/runs 404: unknown automation', async () => {
    const res = await rest.request<{ ok: boolean }>('GET', '/api/automations/ffffffff/runs')
    expect(res.status).toBe(404)
  })

  test('PATCH: updates name + enabled', async () => {
    const res = await rest.request<One>('PATCH', `/api/automations/${createdId}`, {
      name: 'Renamed',
      enabled: false
    })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Renamed')
    expect(res.body.data.enabled).toBe(false)
  })

  test('PATCH 400: empty body', async () => {
    const res = await rest.request<One>('PATCH', `/api/automations/${createdId}`, {})
    expect(res.status).toBe(400)
  })

  test('DELETE: removes automation', async () => {
    const res = await rest.request<One>('DELETE', `/api/automations/${createdId}`)
    expect(res.status).toBe(200)
    const row = h.db.prepare('SELECT 1 AS x FROM automations WHERE id = ?').get(createdId)
    expect(Boolean(row)).toBe(false)
  })

  test('DELETE 404: unknown', async () => {
    const res = await rest.request<One>('DELETE', '/api/automations/ffffffff')
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
