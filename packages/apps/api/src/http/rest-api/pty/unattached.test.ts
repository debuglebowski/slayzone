/**
 * `slay pty unattached` / `attach` / `kill`: terminal sessions a computer still runs
 * from a previous hub run that could not be adopted into their tabs — listed with the
 * reason, attached again or stopped on request (terminal unattached-sessions).
 */
import { afterAll, describe, expect, test } from 'vitest'
import express from 'express'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import type { RestApiDeps } from '../types'
import { registerPtyUnattachedRoutes } from './unattached.js'

const calls: unknown[][] = []
const listed = [
  {
    computerId: 'pc',
    sessionId: 'task-1:tab-1',
    spawnId: 'run-1',
    status: 'unattached',
    reason: 'mode-mismatch'
  }
]
const pty = {
  listUnattached: () => listed,
  attachUnattached: async (computerId: string, sessionId: string) => {
    calls.push(['attach', computerId, sessionId])
    return sessionId === 'task-1:tab-1'
      ? { ok: false, reason: 'mode-mismatch', detail: 'the tab runs codex' }
      : { ok: true }
  },
  killUnattached: async (computerId: string, sessionId: string) => {
    calls.push(['kill', computerId, sessionId])
    if (sessionId === 'task-1:tab-1') return { ok: true }
    return sessionId === 'moved:on'
      ? { ok: false, reason: 'not-stopped' }
      : { ok: false, reason: 'not-found' }
  }
}

const app = express()
app.use(express.json())
registerPtyUnattachedRoutes(app, { pty } as unknown as RestApiDeps)
const h = await mountRestApp(app)
afterAll(() => h.close())

const at = (sessionId: string) => `${h.url}/api/pty/unattached/pc/${encodeURIComponent(sessionId)}`

describe('unattached terminal sessions over REST', () => {
  test('lists them with their reason', async () => {
    const res = await fetch(`${h.url}/api/pty/unattached`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(listed)
  })

  test('attach: 200 when adopted, 409 with the reason when it still cannot be', async () => {
    const refused = await fetch(`${at('task-1:tab-1')}/attach`, { method: 'POST' })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: 'Not attached (mode-mismatch): the tab runs codex',
      reason: 'mode-mismatch'
    })
    const ok = await fetch(`${at('task-2:tab-2')}/attach`, { method: 'POST' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })
  })

  test('kill: stops exactly that session; 404 for one not listed', async () => {
    expect((await fetch(at('task-1:tab-1'), { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(at('gone:gone'), { method: 'DELETE' })).status).toBe(404)
    // Another attempt runs it now: never reported as stopped.
    expect((await fetch(at('moved:on'), { method: 'DELETE' })).status).toBe(409)
    expect(calls.filter((c) => c[0] === 'kill')).toEqual([
      ['kill', 'pc', 'task-1:tab-1'],
      ['kill', 'pc', 'gone:gone'],
      ['kill', 'pc', 'moved:on']
    ])
  })

  test('501 without a pty runtime (a standalone api)', async () => {
    const bare = express()
    registerPtyUnattachedRoutes(bare, {} as RestApiDeps)
    const b = await mountRestApp(bare)
    try {
      expect((await fetch(`${b.url}/api/pty/unattached`)).status).toBe(501)
    } finally {
      await b.close()
    }
  })
})
