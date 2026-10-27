/**
 * T-99: the hub never POSTs to a Convex URL a client names.
 *
 * `app.auth.githubSystemSignIn` over the real `appRouter`, with the host wired the way
 * composition.ts wires the standalone hub's (`requestGithubSignInStart` behind the
 * `hubGithubSignInConvexUrl` backstop) and the global `fetch` stubbed, so every outbound
 * request the hub would make is recorded instead of sent.
 *
 *   - a client `convexUrl` naming any other host → FORBIDDEN `HUB_CONVEX_MISMATCH`, one
 *     audit line, the host never asked, NO outbound request;
 *   - no Convex deployment configured → FORBIDDEN `HUB_CONVEX_NOT_CONFIGURED`, same;
 *   - integrations off → FORBIDDEN `HUB_INTEGRATIONS_DISABLED`, same;
 *   - the desktop app's path — the hub handed `convexAddressFromUrl(VITE_CONVEX_URL)`,
 *     the renderer sending that same `VITE_CONVEX_URL` — POSTs to
 *     `<that origin>/api/action` exactly as before, and the host receives the hub's own
 *     origin.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, describe, expect, test } from 'vitest'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { convexAddressFromUrl } from '@slayzone/platform/hub-convex'
import {
  appRouter,
  hubGithubSignInConvexUrl,
  requestGithubSignInStart,
  setAppDeps
} from '@slayzone/transport/server'

const h = await createTestHarness()

const CONVEX_ENV = 'SLAYZONE_HUB_CONVEX_ADDRESS'
const INTEGRATIONS_ENV = 'SLAYZONE_HUB_ENABLE_INTEGRATIONS'
const REDIRECT = 'slayzone://auth/callback'
/** What the desktop app is built with (`VITE_CONVEX_URL`) — renderer and main alike. */
const BUILD_CONVEX_URL = 'https://happy-animal-123.convex.cloud'

// Every request the hub process sends goes through here and nowhere else.
const outbound: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL) => {
  outbound.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  return new Response(
    JSON.stringify({
      status: 'success',
      value: { redirect: 'https://github.com/login/oauth/authorize?client_id=x', verifier: 'v1' }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}) as typeof fetch

// The host, as composition.ts builds it for a standalone hub (the Electron host runs
// the same `requestGithubSignInStart` on the value the router hands it).
const hostCalls: Array<{ convexUrl: string; redirectTo: string }> = []
setAppDeps({
  authGithubSystemSignIn: async (input: { convexUrl: string; redirectTo: string }) => {
    hostCalls.push(input)
    const start = await requestGithubSignInStart(
      hubGithubSignInConvexUrl(input.convexUrl),
      input.redirectTo,
      'chromium-sidecar'
    )
    return { ok: true, verifier: start.verifier, pending: true }
  }
} as never)

const lines: Array<Record<string, unknown> & { detail: Record<string, unknown> }> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))

type WireError = { message: string; data: { code: string; httpStatus: number; appCode?: string } }

async function signIn(
  convexUrl: unknown
): Promise<{ status: number; data?: unknown; error?: WireError }> {
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request('http://hub/trpc/app.auth.githubSystemSignIn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(superjson.serialize({ convexUrl, redirectTo: REDIRECT }))
    }),
    router: appRouter,
    createContext: () => ({
      db: h.slayDb,
      dataRoot: '/tmp',
      req: { socket: { remoteAddress: '198.51.100.9' } } as never,
      principal: { userId: 'user-7', role: 'user' as const, scopes: ['full'] as const }
    })
  })
  const body = (await res.json()) as {
    result?: { data: { json: unknown } }
    error?: { json: WireError }
  }
  return { status: res.status, data: body.result?.data.json, error: body.error?.json }
}

/** Refused before anything left the hub: 403 + code, one audit line, no host, no fetch. */
async function expectRefused(convexUrl: unknown, appCode: string, variable: string) {
  const before = { lines: lines.length, outbound: outbound.length, host: hostCalls.length }
  const res = await signIn(convexUrl)
  expect(res.status).toBe(403)
  expect(res.error?.data.code).toBe('FORBIDDEN')
  expect(res.error?.data.appCode).toBe(appCode)
  expect(res.error?.message.includes(variable)).toBe(true)
  expect(outbound.length).toBe(before.outbound)
  expect(hostCalls.length).toBe(before.host)
  expect(lines.length).toBe(before.lines + 1)
  const line = lines[before.lines]
  expect(line.event).toBe('integration.connect')
  expect(line.outcome).toBe('denied')
  expect(line.actor).toBe('user-7')
  expect(line.route).toBe('trpc app.auth.githubSystemSignIn')
  expect(line.detail.op).toBe('sign_in')
  expect(line.detail.provider).toBe('github')
  expect(line.detail.code).toBe(appCode)
  return line
}

delete process.env[INTEGRATIONS_ENV]

describe('desktop app hub: the deployment its renderer was built for', () => {
  test('the hub address comes from the build URL', () => {
    expect(convexAddressFromUrl(BUILD_CONVEX_URL)).toBe('happy-animal-123.convex.cloud')
  })

  test('sign-in starts: one POST to <build origin>/api/action, the host gets the hub’s origin', async () => {
    process.env[CONVEX_ENV] = convexAddressFromUrl(BUILD_CONVEX_URL)
    const before = { lines: lines.length, outbound: outbound.length }
    const res = await signIn(BUILD_CONVEX_URL)
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ ok: true, verifier: 'v1', pending: true })
    expect(outbound.slice(before.outbound)).toEqual([`${BUILD_CONVEX_URL}/api/action`])
    expect(hostCalls[hostCalls.length - 1]).toEqual({
      convexUrl: BUILD_CONVEX_URL,
      redirectTo: REDIRECT
    })
    expect(lines.length).toBe(before.lines)
  })

  test('a local `convex dev` backend (loopback, http) works the same', async () => {
    process.env[CONVEX_ENV] = convexAddressFromUrl('http://127.0.0.1:3210')
    const before = outbound.length
    const res = await signIn('http://127.0.0.1:3210')
    expect(res.status).toBe(200)
    expect(outbound.slice(before)).toEqual(['http://127.0.0.1:3210/api/action'])
  })
})

describe('a client naming another Convex host is refused, nothing sent', () => {
  for (const [label, url] of [
    ['another host', 'https://evil.example.com'],
    ['cloud metadata', 'http://169.254.169.254/latest'],
    ['the hub’s own loopback', 'http://127.0.0.1:3100'],
    ['an internal name', 'https://intranet.corp:8443'],
    ['same host over http', 'http://happy-animal-123.convex.cloud'],
    ['no URL at all', undefined]
  ] as const) {
    test(`${label}: FORBIDDEN HUB_CONVEX_MISMATCH, audited, no request`, async () => {
      process.env[CONVEX_ENV] = 'happy-animal-123.convex.cloud'
      const line = await expectRefused(url, 'HUB_CONVEX_MISMATCH', CONVEX_ENV)
      expect(line.detail.requestedOrigin).toBe(url === undefined ? null : new URL(url).origin)
    })
  }
})

describe('no Convex deployment configured (a self-hosted hub): refused', () => {
  test('unset: FORBIDDEN HUB_CONVEX_NOT_CONFIGURED, audited, no request', async () => {
    delete process.env[CONVEX_ENV]
    await expectRefused(BUILD_CONVEX_URL, 'HUB_CONVEX_NOT_CONFIGURED', CONVEX_ENV)
  })
})

describe('integrations switched off (the Normain hub): refused first', () => {
  test('FORBIDDEN HUB_INTEGRATIONS_DISABLED, audited, no request', async () => {
    process.env[INTEGRATIONS_ENV] = '0'
    process.env[CONVEX_ENV] = 'happy-animal-123.convex.cloud'
    await expectRefused(BUILD_CONVEX_URL, 'HUB_INTEGRATIONS_DISABLED', INTEGRATIONS_ENV)
    delete process.env[INTEGRATIONS_ENV]
  })
})

describe('the standalone host’s backstop', () => {
  test('called past the router with a foreign URL, it refuses before any request', async () => {
    process.env[CONVEX_ENV] = 'happy-animal-123.convex.cloud'
    const before = outbound.length
    let err: unknown = null
    try {
      hubGithubSignInConvexUrl('https://evil.example.com')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string } | null)?.code).toBe('HUB_CONVEX_MISMATCH')
    expect(outbound.length).toBe(before)
  })
})

afterAll(() => h.cleanup())
