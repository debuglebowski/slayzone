/**
 * REST: POST /api/auth/deep-link — the HTTP entry point for the chromium-fork
 * OAuth deep-link on platforms where `slayzone://` is routed to the sidecar over
 * HTTP rather than the mac C++ Unix socket (Linux's `.desktop` handler + Windows'
 * registry handler, scripts/chromium/{linux,windows}/). Both POST the callback URL
 * here; this route converges on the SAME chain the socket path uses:
 * `parseAuthCallbackUrl` → `authEvents.emit('callback')` → the `app.auth.onCallback`
 * tRPC subscription → the renderer's ConvexAuthBridge completes the Convex sign-in.
 *
 * The socket path has an integration test; this route did not — yet it's the entry
 * the two argv-platform handlers depend on. Covers both accepted forms (the
 * `?url=` query form the curl/PowerShell helpers use, and a JSON `{url}` body),
 * the empty-host `slayzone:///auth/callback` normalization, error passthrough, and
 * the 400/no-emit rejections.
 *
 * Run with: pnpm tsx --loader ./packages/shared/test-utils/loader.ts \
 *   packages/shared/transport/src/server/http/rest-api/auth-deep-link.test.ts
 */
import express from 'express'
import { test, expect, describe } from '../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../test-utils/rest-harness.js'
import { TypedEmitter } from '@slayzone/platform/events'
// Relative (NOT the barrel) so the module-global authEvents singleton this test
// sets is the SAME instance the route reads via `getAuthEvents()`.
import { setAuthEvents, type AuthEventMap } from '../../app-deps.js'
import { registerAuthDeepLinkRoute } from './auth-deep-link.js'
import type { RestApiDeps } from './types.js'

// Capture every callback the route emits. The route ignores its deps, so a stub
// cast is enough — no DB / Electron harness needed.
const received: Array<{ code?: string; error?: string }> = []
const authEvents = new TypedEmitter<AuthEventMap>()
authEvents.on('callback', (payload) => received.push(payload))
setAuthEvents(authEvents)

const app = express()
app.use(express.json())
registerAuthDeepLinkRoute(app, { notifyRenderer: () => {} } as unknown as RestApiDeps)
const rest = await mountRestApp(app)

interface DeepLinkRes {
  ok?: boolean
  error?: string
}

const q = (url: string): string => `/api/auth/deep-link?url=${encodeURIComponent(url)}`

await describe('POST /api/auth/deep-link', () => {
  test('?url= query form (curl/PowerShell helper) emits callback{code}', async () => {
    received.length = 0
    const res = await rest.request<DeepLinkRes>('POST', q('slayzone://auth/callback?code=ABC123'))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(received.length).toBe(1)
    expect(received[0].code).toBe('ABC123')
  })

  test('JSON {url} body form emits callback{code}', async () => {
    received.length = 0
    const res = await rest.request<DeepLinkRes>('POST', '/api/auth/deep-link', {
      url: 'slayzone://auth/callback?code=BODYCODE'
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(received.length).toBe(1)
    expect(received[0].code).toBe('BODYCODE')
  })

  test('empty-host slayzone:///auth/callback normalization is accepted', async () => {
    received.length = 0
    const res = await rest.request<DeepLinkRes>('POST', q('slayzone:///auth/callback?code=TRIPLE'))
    expect(res.status).toBe(200)
    expect(received.length).toBe(1)
    expect(received[0].code).toBe('TRIPLE')
  })

  test('error callback (user denied) passes the error through', async () => {
    received.length = 0
    const res = await rest.request<DeepLinkRes>(
      'POST',
      q('slayzone://auth/callback?error=access_denied')
    )
    expect(res.status).toBe(200)
    expect(received.length).toBe(1)
    expect(received[0].error).toBe('access_denied')
    expect(received[0].code).toBe(undefined)
  })

  test('missing url → 400, no emit', async () => {
    received.length = 0
    const res = await rest.request<DeepLinkRes>('POST', '/api/auth/deep-link')
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(received.length).toBe(0)
  })

  test('non-callback slayzone:// url → 400, no emit', async () => {
    received.length = 0
    const res = await rest.request<DeepLinkRes>('POST', q('slayzone://something/else?code=NOPE'))
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(received.length).toBe(0)
  })
})

await rest.close()
