/**
 * REST: `PATCH /api/hub/computers` contract tests — revoke / unrevoke a computer
 * (`slay hub computers`, a break-glass session). Who may call it is the hub's bearer
 * gate plus the role gate (`REST_ADMIN_POLICY` 'admin', admin-policy.test.ts); this
 * isolates what the route owns: body validation, 404, the store change, dropping the
 * live connection, the audit line.
 *
 * Run with the electron+loader runner (better-sqlite3 native ABI via the harness DB).
 */
import express from 'express'
import {
  createTestHarness,
  describe,
  expect,
  test
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { getComputer, registerComputer } from '@slayzone/computers/server'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { registerHubComputersRoute } from './computers.js'

const h = await createTestHarness()
await registerComputer(h.slayDb, { id: 'c-1', name: 'laptop', platform: 'p', version: '0' })

const dropped: string[] = []
const app = express()
app.use(express.json())
registerHubComputersRoute(app, {
  db: h.slayDb,
  notifyRenderer: () => {},
  computers: {
    getHubUrl: () => null,
    getGateway: () => ({
      listComputers: () => [],
      listUsableComputers: () => [],
      disconnect: (id: string) => void dropped.push(id)
    })
  }
})
const r = await mountRestApp(app)

await describe('PATCH /api/hub/computers', () => {
  test('400 without { id, revoked }', async () => {
    expect((await r.request('PATCH', '/api/hub/computers', { id: 'c-1' })).status).toBe(400)
    expect((await r.request('PATCH', '/api/hub/computers', { revoked: true })).status).toBe(400)
  })

  test('404 for an unknown computer, nothing changed', async () => {
    const res = await r.request('PATCH', '/api/hub/computers', { id: 'nope', revoked: true })
    expect(res.status).toBe(404)
    expect(dropped).toEqual([])
  })

  test('revoke: revoked_at set, live connection dropped, one audit line', async () => {
    const lines: Array<Record<string, unknown>> = []
    setSecurityLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>))
    try {
      const res = await r.request('PATCH', '/api/hub/computers', { id: 'c-1', revoked: true })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, data: { id: 'c-1', revoked: true } })
    } finally {
      setSecurityLogSink()
    }
    expect(typeof (await getComputer(h.slayDb, 'c-1'))?.revoked_at).toBe('number')
    expect(dropped).toEqual(['c-1'])
    expect(lines.map((l) => `${l.event}:${l.outcome}:${l.targetId}`)).toEqual([
      'computer.revoke:success:c-1'
    ])
  })

  test('unrevoke: restored, no connection touched', async () => {
    const res = await r.request('PATCH', '/api/hub/computers', { id: 'c-1', revoked: false })
    expect(res.status).toBe(200)
    expect((await getComputer(h.slayDb, 'c-1'))?.revoked_at).toBeNull()
    expect(dropped).toEqual(['c-1'])
  })
})

await r.close()
h.cleanup()
