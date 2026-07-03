/**
 * Build-identity tests (Phase 1 of plans/sidecar-staleness.md).
 *
 * Pure — no DB, no native deps — so it runs under plain `npx tsx`.
 *  - getServerBuildInfo() falls back cleanly when the esbuild `define`s are
 *    absent (i.e. running the TS source directly, as here / in dev).
 *  - GET /health advertises the running build (commit / builtAt / buildId) so a
 *    stale sidecar is detectable by comparing against dist/sidecar-build.json.
 *
 * Run with: npx tsx packages/apps/server/src/build-info.test.ts
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getServerBuildInfo } from './build-info.js'
import { handleHealth, type HealthState } from './health.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

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
  const req = { url: '/health', method: 'GET' } as IncomingMessage
  return { req, res, read: () => ({ status, body: body ? JSON.parse(body) : undefined }) }
}

console.log('\nbuild-info + /health')
console.log('─'.repeat(40))

test('getServerBuildInfo() returns strings for commit/builtAt/buildId', () => {
  const info = getServerBuildInfo()
  assert(typeof info.commit === 'string' && info.commit.length > 0, 'commit is a non-empty string')
  assert(typeof info.builtAt === 'string' && info.builtAt.length > 0, 'builtAt is a non-empty string')
  assert(typeof info.buildId === 'string' && info.buildId.length > 0, 'buildId is a non-empty string')
})

test('getServerBuildInfo() falls back to dev sentinels when defines absent', () => {
  const info = getServerBuildInfo()
  // Running TS source directly: no esbuild `define` substitution → sentinels.
  assert(info.commit === 'dev', `commit sentinel, got ${info.commit}`)
  assert(info.builtAt === 'unknown', `builtAt sentinel, got ${info.builtAt}`)
  assert(info.buildId === 'dev@unknown', `buildId composed from parts, got ${info.buildId}`)
})

test('GET /health (ready) advertises the running build identity', () => {
  const state: HealthState = { ready: true, port: 1234, startedAt: Date.now(), dbPath: '/tmp/x.sqlite' }
  const { req, res, read } = fakeHealthResponse()
  const handled = handleHealth(state, req, res)
  assert(handled, 'handleHealth handled the /health request')
  const { status, body } = read()
  assert(status === 200, `200 when ready, got ${status}`)
  const b = body as Record<string, unknown>
  assert(b.ok === true, 'ok:true')
  assert(typeof b.commit === 'string', 'body carries commit')
  assert(typeof b.builtAt === 'string', 'body carries builtAt')
  assert(typeof b.buildId === 'string', 'body carries buildId')
  // Existing fields preserved.
  assert(b.port === 1234, 'port preserved')
  assert(b.dbPath === '/tmp/x.sqlite', 'dbPath preserved')
})

test('GET /health (not ready) still 503s without build fields', () => {
  const state: HealthState = { ready: false, port: 0, startedAt: Date.now(), dbPath: '/tmp/x.sqlite' }
  const { req, res, read } = fakeHealthResponse()
  handleHealth(state, req, res)
  const { status, body } = read()
  assert(status === 503, `503 when starting, got ${status}`)
  assert((body as Record<string, unknown>).ok === false, 'ok:false while starting')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
