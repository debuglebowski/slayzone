/**
 * REST: /api/panels contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/panels/crud.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerPanelsCrudRoutes } from './crud.js'

const h = await createTestHarness()

let notifyCount = 0
const app = express()
app.use(express.json())
registerPanelsCrudRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

interface Panel {
  id: string
  name: string
  baseUrl: string
  predefined?: boolean
}
type ListResponse = { ok: boolean; data: Panel[] }
type OneResponse = { ok: boolean; data: Panel; error?: string }

let createdId = ''

await describe('/api/panels', () => {
  test('GET: returns predefined panels with no stored config', async () => {
    const res = await rest.request<ListResponse>('GET', '/api/panels')
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)
    expect(res.body.data.every((p) => typeof p.id === 'string')).toBe(true)
  })

  test('POST: creates custom panel, persists to settings + notifies', async () => {
    notifyCount = 0
    const res = await rest.request<OneResponse>('POST', '/api/panels', {
      name: 'My Docs',
      url: 'docs.example.com'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('My Docs')
    expect(res.body.data.baseUrl).toBe('https://docs.example.com')
    expect(res.body.data.id.startsWith('web:')).toBe(true)
    expect(notifyCount).toBe(1)
    createdId = res.body.data.id

    const stored = h.db
      .prepare(`SELECT value FROM settings WHERE key = 'panel_config'`)
      .get() as { value: string }
    const config = JSON.parse(stored.value) as { webPanels: Panel[] }
    expect(config.webPanels.some((p) => p.id === createdId)).toBe(true)
  })

  test('GET: includes the created panel', async () => {
    const res = await rest.request<ListResponse>('GET', '/api/panels')
    expect(res.body.data.some((p) => p.id === createdId)).toBe(true)
  })

  test('POST 400: missing name', async () => {
    const res = await rest.request<OneResponse>('POST', '/api/panels', { url: 'x.com' })
    expect(res.status).toBe(400)
  })

  test('POST 400: protocol without blockHandoff', async () => {
    const res = await rest.request<OneResponse>('POST', '/api/panels', {
      name: 'Bad',
      url: 'x.com',
      protocol: 'figma'
    })
    expect(res.status).toBe(400)
  })

  test('DELETE by name: removes custom panel', async () => {
    const res = await rest.request<OneResponse>('DELETE', '/api/panels/My%20Docs')
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(createdId)
    const list = await rest.request<ListResponse>('GET', '/api/panels')
    expect(list.body.data.some((p) => p.id === createdId)).toBe(false)
  })

  test('DELETE predefined panel: tombstoned via deletedPredefined', async () => {
    const list = await rest.request<ListResponse>('GET', '/api/panels')
    const predefined = list.body.data.find((p) => p.predefined)
    expect(Boolean(predefined)).toBe(true)
    const res = await rest.request<OneResponse>('DELETE', `/api/panels/${predefined!.id}`)
    expect(res.status).toBe(200)
    const stored = h.db
      .prepare(`SELECT value FROM settings WHERE key = 'panel_config'`)
      .get() as { value: string }
    const config = JSON.parse(stored.value) as { deletedPredefined?: string[] }
    expect(config.deletedPredefined?.includes(predefined!.id)).toBe(true)
    const after = await rest.request<ListResponse>('GET', '/api/panels')
    expect(after.body.data.some((p) => p.id === predefined!.id)).toBe(false)
  })

  test('DELETE 404: unknown panel', async () => {
    const res = await rest.request<OneResponse>('DELETE', '/api/panels/definitely-not-a-panel')
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
