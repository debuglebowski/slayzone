/**
 * REST: GET /api/projects/resolve-by-path contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/projects/resolve-by-path.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerProjectsResolveByPathRoute } from './resolve-by-path.js'

const h = await createTestHarness()

const outer = crypto.randomUUID()
const nested = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(outer, 'Outer', '#000', '/repo/outer')
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(nested, 'Nested', '#000', '/repo/outer/nested')
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(crypto.randomUUID(), 'Pathless', '#000', null)

const app = express()
app.use(express.json())
registerProjectsResolveByPathRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)

type ResolveResponse = { ok: boolean; data: { id: string; name: string; path: string } }

await describe('GET /api/projects/resolve-by-path', () => {
  test('happy: exact path match', async () => {
    const res = await rest.request<ResolveResponse>(
      'GET',
      `/api/projects/resolve-by-path?path=${encodeURIComponent('/repo/outer')}`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(outer)
  })

  test('happy: deepest containing project wins for nested dirs', async () => {
    const res = await rest.request<ResolveResponse>(
      'GET',
      `/api/projects/resolve-by-path?path=${encodeURIComponent('/repo/outer/nested/src/deep')}`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(nested)
  })

  test('happy: trailing slashes ignored', async () => {
    const res = await rest.request<ResolveResponse>(
      'GET',
      `/api/projects/resolve-by-path?path=${encodeURIComponent('/repo/outer/')}`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(outer)
  })

  test('404: no containing project', async () => {
    const res = await rest.request<ResolveResponse>(
      'GET',
      `/api/projects/resolve-by-path?path=${encodeURIComponent('/elsewhere')}`
    )
    expect(res.status).toBe(404)
  })

  test('400: missing path', async () => {
    const res = await rest.request<ResolveResponse>('GET', '/api/projects/resolve-by-path')
    expect(res.status).toBe(400)
  })
})

await rest.close()
h.cleanup()
