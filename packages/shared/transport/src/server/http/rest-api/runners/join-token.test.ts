/**
 * REST: POST /api/runners/join-token contract tests (Wave3.5-D3).
 * Run with the electron+loader runner (better-sqlite3 native ABI via the harness DB).
 *
 * The route is the loopback mint channel the Electron MAIN process hits at boot
 * to auto-enroll its local runner (main has no tRPC client to the sidecar). It
 * wraps the same store `mintJoinToken` as the runners tRPC proc, gated on the
 * `deps.runners` slot (wired once the runner init resolves):
 *   - runner ON + listener bound  → 200 { token (decodable szjt1), hubUrl (wss) }
 *   - runner ON + not-yet-bound   → 503 (main retries)
 *   - runner OFF (slot absent)    → 503 (never mints; default boot byte-identical)
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { decodeJoinToken } from '@slayzone/runners/server'
import { registerRunnersJoinTokenRoute } from './join-token.js'
import type { RestApiDeps } from '../types.js'

const h = await createTestHarness()

/** A bound runner listener (runner ON, url + fingerprint present). */
const boundRunners = {
  getHubUrl: () => 'wss://127.0.0.1:54321/runners',
  getCertFingerprint: () => 'abcdef0123456789'
}

function mount(runners: RestApiDeps['runners']) {
  const app = express()
  app.use(express.json())
  registerRunnersJoinTokenRoute(app, { db: h.slayDb, notifyRenderer: () => {}, runners })
  return mountRestApp(app)
}

await describe('POST /api/runners/join-token', () => {
  test('runner ON + bound: mints a decodable szjt1 token embedding the wss hub url', async () => {
    const rest = await mount(boundRunners)
    try {
      const res = await rest.request<{ token: string; hubUrl: string }>(
        'POST',
        '/api/runners/join-token',
        { label: 'local-runner' }
      )
      expect(res.status).toBe(200)
      expect(res.body.hubUrl).toBe('wss://127.0.0.1:54321/runners')
      const payload = decodeJoinToken(res.body.token)
      expect(payload).not.toBeNull()
      expect(payload!.hubUrl).toBe('wss://127.0.0.1:54321/runners')
      expect(payload!.certFingerprint).toBe('abcdef0123456789')
    } finally {
      await rest.close()
    }
  })

  test('runner ON but listener not yet bound (null url): 503', async () => {
    const rest = await mount({ getHubUrl: () => null, getCertFingerprint: () => null })
    try {
      const res = await rest.request<{ error: string }>('POST', '/api/runners/join-token', {})
      expect(res.status).toBe(503)
    } finally {
      await rest.close()
    }
  })

  test('runner OFF (runners slot absent): 503, never mints', async () => {
    const rest = await mount(undefined)
    try {
      const res = await rest.request<{ error: string }>('POST', '/api/runners/join-token', {})
      expect(res.status).toBe(503)
    } finally {
      await rest.close()
    }
  })

  test('defaults the label when omitted', async () => {
    const rest = await mount(boundRunners)
    try {
      const res = await rest.request<{ token: string; hubUrl: string }>(
        'POST',
        '/api/runners/join-token',
        {}
      )
      expect(res.status).toBe(200)
      expect(typeof res.body.token).toBe('string')
    } finally {
      await rest.close()
    }
  })
})

h.cleanup()
