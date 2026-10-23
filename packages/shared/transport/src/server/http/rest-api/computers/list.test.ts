/**
 * REST: GET /api/computers (T-19). On a hub with login the roster is the caller's own
 * computers, or every one for an admin (management metadata); an unowned computer is
 * the admin's to see and nobody else's. Without login (the desktop app's hub) it is
 * every active computer, as before.
 *
 * Electron strict loader (better-sqlite3 native ABI via the harness DB).
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { setAuthGate } from '../../../app-deps.js'
import { bindRestPrincipal } from '../principal.js'
import type { RestPrincipal } from '../types.js'
import { registerComputersListRoute } from './list.js'

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
sql(
  `INSERT INTO computers (id, name, platform, version, capabilities_json, last_seen_at, created_at,
     owner_user_id, revoked_at) VALUES
   ('cA', 'a-box', 'linux-x64', '0', '{}', 0, 1, 'user-a', NULL),
   ('cB', 'b-box', 'linux-x64', '0', '{}', 0, 2, 'user-b', NULL),
   ('cU', 'nobodys', 'linux-x64', '0', '{}', 0, 3, NULL, NULL),
   ('cGone', 'revoked', 'linux-x64', '0', '{}', 0, 4, 'user-a', 5)`
)

/** The route as `principal` (null: the gate let the request through unverified). */
async function idsAs(principal: RestPrincipal | null): Promise<string[]> {
  const app = express()
  app.use((req, _res, next) => {
    if (principal) bindRestPrincipal(req, principal)
    next()
  })
  registerComputersListRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
  const rest = await mountRestApp(app)
  try {
    const res = await rest.request<Array<{ id: string }>>('GET', '/api/computers')
    expect(res.status).toBe(200)
    return res.body.map((r) => r.id).sort()
  } finally {
    await rest.close()
  }
}

const user = (userId: string, role: 'admin' | 'user' = 'user'): RestPrincipal => ({
  userId,
  role,
  scopes: ['full']
})

await describe('GET /api/computers', () => {
  test("a hub with login: the caller's own; every one for an admin", async () => {
    setAuthGate(() => true)
    try {
      expect(await idsAs(user('user-a'))).toEqual(['cA'])
      expect(await idsAs(user('user-b'))).toEqual(['cB'])
      expect(await idsAs(user('user-admin', 'admin'))).toEqual(['cA', 'cB', 'cU'])
      expect(await idsAs(null)).toEqual([])
    } finally {
      setAuthGate(() => false)
    }
  })

  test('without login (the desktop hub): every active computer, as before', async () => {
    expect(await idsAs(null)).toEqual(['cA', 'cB', 'cU'])
  })
})
