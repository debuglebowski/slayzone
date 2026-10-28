/**
 * REST: /api/panels contract tests.
 */
import { afterAll, describe, expect, test } from 'vitest'
import express from 'express'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { bindRestPrincipal } from '../principal.js'
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

describe('/api/panels', () => {
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

    const stored = h.db.prepare(`SELECT value FROM settings WHERE key = 'panel_config'`).get() as {
      value: string
    }
    const config = JSON.parse(stored.value) as { webPanels: Panel[] }
    expect(config.webPanels.some((p) => p.id === createdId)).toBe(true)
  })

  test('GET: includes the created panel', async () => {
    const res = await rest.request<ListResponse>('GET', '/api/panels')
    expect(res.body.data.some((p) => p.id === createdId)).toBe(true)
  })

  test('PATCH: enable panel persists viewEnabled.task[id] = true', async () => {
    const res = await rest.request<{ ok: boolean; data: { id: string; enabled: boolean } }>(
      'PATCH',
      `/api/panels/${createdId}`,
      { enabled: true }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.enabled).toBe(true)
    const stored = h.db.prepare(`SELECT value FROM settings WHERE key = 'panel_config'`).get() as {
      value: string
    }
    const config = JSON.parse(stored.value) as { viewEnabled?: { task?: Record<string, boolean> } }
    expect(config.viewEnabled?.task?.[createdId]).toBe(true)
  })

  test('PATCH: disable panel by name', async () => {
    const res = await rest.request<{ ok: boolean; data: { enabled: boolean } }>(
      'PATCH',
      '/api/panels/My%20Docs',
      { enabled: false }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.enabled).toBe(false)
  })

  test('PATCH 400: missing enabled', async () => {
    const res = await rest.request<OneResponse>('PATCH', `/api/panels/${createdId}`, {})
    expect(res.status).toBe(400)
  })

  test('PATCH 404: unknown panel', async () => {
    const res = await rest.request<OneResponse>('PATCH', '/api/panels/definitely-not-a-panel', {
      enabled: true
    })
    expect(res.status).toBe(404)
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
    const stored = h.db.prepare(`SELECT value FROM settings WHERE key = 'panel_config'`).get() as {
      value: string
    }
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

// T-16: `panel_config` is per user. A request with a user (the hub's bearer gate
// binds it; stood in for here by a header) reads and writes its own copy; a request
// without one (a hub without login) keeps the global row the tests above used.
const userApp = express()
userApp.use(express.json())
userApp.use((req, _res, next) => {
  const user = req.headers['x-test-user']
  if (typeof user === 'string')
    bindRestPrincipal(req, { userId: user, role: 'user', scopes: ['full'] })
  next()
})
registerPanelsCrudRoutes(userApp, { db: h.slayDb, notifyRenderer: () => {} })
const userRest = await mountRestApp(userApp)
const call = async <T>(method: string, path: string, user?: string, body?: unknown) => {
  const res = await fetch(`${userRest.url}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(user ? { 'x-test-user': user } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  return { status: res.status, body: (await res.json()) as T }
}

describe('/api/panels per user', () => {
  test("a user's custom panel is theirs: not another user's, not the global config", async () => {
    const created = await call<OneResponse>('POST', '/api/panels', 'user-a', {
      name: 'A only',
      url: 'https://a.example.com'
    })
    expect(created.status).toBe(200)
    const has = async (user?: string) =>
      (await call<ListResponse>('GET', '/api/panels', user)).body.data.some(
        (p) => p.name === 'A only'
      )
    expect(await has('user-a')).toBe(true)
    expect(await has('user-b')).toBe(false)
    expect(await has(undefined)).toBe(false)
    const row = h.db
      .prepare(
        `SELECT count(*) AS n FROM user_settings WHERE user_id = 'user-a' AND key = 'panel_config'`
      )
      .get() as { n: number }
    expect(row.n).toBe(1)
  })
})

afterAll(async () => {
  await userRest.close()
  await rest.close()
  h.cleanup()
})
