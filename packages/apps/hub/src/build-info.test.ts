/**
 * Build-identity tests (Phase 1 of plans/sidecar-staleness.md).
 *
 * Pure — no DB, no native deps.
 *  - getServerBuildInfo() falls back cleanly when the esbuild `define`s are
 *    absent (i.e. running the TS source directly, as here / in dev).
 *  - GET /health advertises the running build (commit / builtAt / buildId) so a
 *    stale sidecar is detectable by comparing against dist/sidecar-build.json.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { expect, test } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getServerBuildInfo } from './build-info.js'
import { handleHealth, type HealthState } from './health.js'

/** Capture what handleHealth writes without a real socket. */
function fakeHealthResponse(): {
  req: IncomingMessage
  res: ServerResponse
  read: () => { status: number; body: unknown }
} {
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number) => {
      status = code
      return res
    },
    end: (chunk?: string) => {
      if (chunk) body = chunk
      return res
    }
  } as unknown as ServerResponse
  // `socket.remoteAddress` must be present: handleHealth serves the identity
  // fields (dbPath included) to loopback callers only, and fails CLOSED when the
  // peer address is unknown. See health.test.ts for the gating itself.
  const req = {
    url: '/health',
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' }
  } as IncomingMessage
  return { req, res, read: () => ({ status, body: body ? JSON.parse(body) : undefined }) }
}

/** Health state with the identity fields filled in — this suite only asserts the
 *  build fields, so the values are placeholders. */
function healthState(overrides: Partial<HealthState>): HealthState {
  return {
    ready: true,
    port: 1234,
    startedAt: Date.now(),
    dbPath: '/tmp/x.sqlite',
    name: 'test-hub',
    root: '/tmp/test-root',
    pid: process.pid,
    supervised: false,
    authRequired: false,
    switches: {
      requireLogin: false,
      enablePassword: true,
      enableSso: false,
      enableProcesses: true,
      enableIntegrations: true
    },
    reachable: false,
    computersConnected: () => 0,
    ...overrides
  }
}

console.log('\nbuild-info + /health')
console.log('─'.repeat(40))

test('getServerBuildInfo() returns strings for commit/builtAt/buildId', () => {
  const info = getServerBuildInfo()
  expect(typeof info.commit, 'commit is a non-empty string').toBe('string')
  expect(info.commit.length, 'commit is a non-empty string').toBeGreaterThan(0)
  expect(typeof info.builtAt, 'builtAt is a non-empty string').toBe('string')
  expect(info.builtAt.length, 'builtAt is a non-empty string').toBeGreaterThan(0)
  expect(typeof info.buildId, 'buildId is a non-empty string').toBe('string')
  expect(info.buildId.length, 'buildId is a non-empty string').toBeGreaterThan(0)
})

test('getServerBuildInfo() falls back to dev sentinels when defines absent', () => {
  const info = getServerBuildInfo()
  // Running TS source directly: no esbuild `define` substitution → sentinels.
  expect(info.commit, `commit sentinel, got ${info.commit}`).toBe('dev')
  expect(info.builtAt, `builtAt sentinel, got ${info.builtAt}`).toBe('unknown')
  expect(info.buildId, `buildId composed from parts, got ${info.buildId}`).toBe('dev@unknown')
})

test('GET /health (ready) advertises the running build identity', () => {
  const state = healthState({ ready: true })
  const { req, res, read } = fakeHealthResponse()
  const handled = handleHealth(state, req, res)
  expect(handled, 'handleHealth handled the /health request').toBeTruthy()
  const { status, body } = read()
  expect(status, `200 when ready, got ${status}`).toBe(200)
  const b = body as Record<string, unknown>
  expect(b.ok, 'ok:true').toBe(true)
  expect(typeof b.commit, 'body carries commit').toBe('string')
  expect(typeof b.builtAt, 'body carries builtAt').toBe('string')
  expect(typeof b.buildId, 'body carries buildId').toBe('string')
  // Existing fields preserved.
  expect(b.port, 'port preserved').toBe(1234)
  expect(b.dbPath, 'dbPath preserved').toBe('/tmp/x.sqlite')
})

test('GET /health (not ready) still 503s without build fields', () => {
  const state = healthState({ ready: false, port: 0 })
  const { req, res, read } = fakeHealthResponse()
  handleHealth(state, req, res)
  const { status, body } = read()
  expect(status, `503 when starting, got ${status}`).toBe(503)
  expect((body as Record<string, unknown>).ok, 'ok:false while starting').toBe(false)
})
