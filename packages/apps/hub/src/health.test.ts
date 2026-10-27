/**
 * `/health` identity + loopback gating (plans/hub-lifecycle-and-discovery.md,
 * Phase 1).
 *
 * `/health` is the sole discovery channel for `slay hub ls` — it must carry
 * enough identity to name a hub (name/root/pid/supervised/computers) without
 * any shared state. And because a hub may bind wider than loopback, the fields
 * that describe the FILESYSTEM (root, dbPath) or the process (pid) must be
 * withheld from non-loopback callers: today `dbPath` is served to anyone who can
 * reach the port.
 *
 * Pure Node (real ephemeral HTTP servers, no native deps).
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleHealth, type HealthState } from './health.js'

const BASE_STATE: Omit<HealthState, 'ready'> = {
  port: 51110,
  startedAt: Date.now() - 5_000,
  dbPath: '/tmp/slz-test-root/storage/slayzone.sqlite',
  name: 'test-hub',
  root: '/tmp/slz-test-root',
  pid: 4321,
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
  computersConnected: () => 2
}

/**
 * Stands up a real HTTP server wired to `handleHealth`, so the loopback gate is
 * exercised through an actual socket (its `remoteAddress` is what the gate
 * reads) rather than a hand-rolled request object.
 *
 * @param host bind address. '127.0.0.1' → the client is a loopback peer;
 *             '0.0.0.0' lets the caller dial a non-loopback local IP.
 */
async function startHealthServer(
  state: Partial<HealthState> = {},
  host = '127.0.0.1'
): Promise<{ port: number; close: () => Promise<void> }> {
  const merged: HealthState = { ...BASE_STATE, ready: true, ...state }
  const srv = http.createServer((req, res) => {
    if (handleHealth(merged, req, res)) return
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => srv.listen(0, host, () => resolve()))
  const port = (srv.address() as AddressInfo).port
  return { port, close: () => new Promise((r) => srv.close(() => r())) }
}

async function getHealth(
  port: number,
  host = '127.0.0.1',
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://${host}:${port}/health`, { headers })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`non-JSON /health body: ${text}`)
  }
  return { status: res.status, body }
}

/**
 * A non-loopback IPv4 address of THIS machine, or null when the host has none
 * (CI containers sometimes only have lo). Used to dial our own 0.0.0.0-bound
 * server from a non-loopback peer address.
 */
async function nonLoopbackAddress(): Promise<string | null> {
  const { networkInterfaces } = await import('node:os')
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}

test('503 while not ready, and leaks nothing', async () => {
  const srv = await startHealthServer({ ready: false })
  try {
    const { status, body } = await getHealth(srv.port)
    expect(status, 'not-ready status').toBe(503)
    expect(body.ok, 'ok=false').toBe(false)
    expect(body.dbPath, 'no dbPath before ready').toBeUndefined()
    expect(body.root, 'no root before ready').toBeUndefined()
  } finally {
    await srv.close()
  }
})

test('loopback caller gets the full identity set', async () => {
  const srv = await startHealthServer()
  try {
    const { status, body } = await getHealth(srv.port)
    expect(status, 'ok status').toBe(200)
    expect(body.ok, 'ok=true').toBe(true)
    // Discovery keys off these — `slay hub ls` cannot render a row without them.
    expect(body.name, 'name').toBe('test-hub')
    expect(body.root, 'root').toBe('/tmp/slz-test-root')
    expect(body.pid, 'pid').toBe(4321)
    expect('mode' in body, 'SLAYZONE_MODE is gone: /health no longer reports a mode').toBeFalsy()
    expect(body.supervised, 'supervised').toBe(false)
    expect(body.computersConnected, 'computersConnected resolved from the getter').toBe(2)
    expect(body.dbPath, 'dbPath').toBe(BASE_STATE.dbPath)
    expect(body.port, 'port').toBe(51110)
    expect(typeof body.uptimeMs, 'uptimeMs').toBe('number')
    expect(body.uptimeMs, 'uptimeMs').toBeGreaterThanOrEqual(5_000)
  } finally {
    await srv.close()
  }
})

test('computersConnected reflects the live gateway, not a boot snapshot', async () => {
  let count = 0
  const srv = await startHealthServer({ computersConnected: () => count })
  try {
    expect((await getHealth(srv.port)).body.computersConnected, 'starts at 0').toBe(0)
    count = 3
    expect((await getHealth(srv.port)).body.computersConnected, 'follows the getter').toBe(3)
  } finally {
    await srv.close()
  }
})

test('supervised=true is reported (hub ls tags it, hub stop refuses it)', async () => {
  const srv = await startHealthServer({ supervised: true })
  try {
    expect((await getHealth(srv.port)).body.supervised, 'supervised').toBe(true)
  } finally {
    await srv.close()
  }
})

test('non-loopback caller is denied every path/process field', async () => {
  const external = await nonLoopbackAddress()
  if (!external) {
    console.log('    (skipped — host has no non-loopback IPv4)')
    return
  }
  const srv = await startHealthServer({}, '0.0.0.0')
  try {
    const { status, body } = await getHealth(srv.port, external)
    expect(status, 'still 200 — liveness is public').toBe(200)
    expect(body.ok, 'ok=true').toBe(true)
    // Public: liveness + build identity, nothing that describes the host.
    expect(body.port, 'port stays public').toBe(51110)
    expect(typeof body.uptimeMs, 'uptimeMs stays public').toBe('number')
    expect('buildId' in body, 'buildId stays public').toBeTruthy()
    // Withheld: absolute paths + pid. dbPath is the pre-existing leak.
    expect(body.dbPath, 'dbPath withheld').toBeUndefined()
    expect(body.root, 'root withheld').toBeUndefined()
    expect(body.pid, 'pid withheld').toBeUndefined()
    expect(body.name, 'name withheld').toBeUndefined()
    expect(body.computersConnected, 'computersConnected withheld').toBeUndefined()
  } finally {
    await srv.close()
  }
})

// A reverse proxy on this machine delivers every remote request from a loopback
// socket. On a hub other machines reach, a loopback peer that carries the headers a
// proxy adds is therefore NOT a local caller.
test('reachable hub: a loopback peer with proxy headers gets no host fields', async () => {
  const srv = await startHealthServer({ reachable: true })
  try {
    const proxied: Array<Record<string, string>> = [
      { 'X-Forwarded-For': '203.0.113.9' },
      { Forwarded: 'for=203.0.113.9;proto=https' },
      { 'X-Real-IP': '203.0.113.9' },
      { Via: '1.1 front-end' }
    ]
    for (const headers of proxied) {
      const { status, body } = await getHealth(srv.port, '127.0.0.1', headers)
      const which = Object.keys(headers)[0]
      expect(status, `${which}: liveness is still public`).toBe(200)
      expect(body.ok, `${which}: ok=true`).toBe(true)
      expect(body.authRequired, `${which}: authRequired stays public`).toBe(false)
      expect('switches' in body, `${which}: switches stay public`).toBeTruthy()
      for (const field of ['name', 'root', 'dbPath', 'pid', 'supervised', 'computersConnected']) {
        expect(field in body, `${which}: ${field} withheld from a forwarded request`).toBeFalsy()
      }
    }
  } finally {
    await srv.close()
  }
})

// `slay hub ls/stop/restart/users add` find a hub by these fields, so a reachable
// hub must keep serving them to a direct local caller.
test('reachable hub: a direct loopback caller (no proxy headers) still gets them', async () => {
  const srv = await startHealthServer({ reachable: true })
  try {
    const { body } = await getHealth(srv.port)
    expect(body.name, 'name').toBe('test-hub')
    expect(body.root, 'root').toBe('/tmp/slz-test-root')
    expect(body.pid, 'pid').toBe(4321)
    expect(body.computersConnected, 'computersConnected').toBe(2)
  } finally {
    await srv.close()
  }
})

test('hub only this machine reaches: proxy headers do not hide the fields', async () => {
  // Nobody but this machine can connect, so there is no remote caller to hide from.
  const srv = await startHealthServer({ reachable: false })
  try {
    const { body } = await getHealth(srv.port, '127.0.0.1', { 'X-Forwarded-For': '10.0.0.1' })
    expect(body.name, 'name still served').toBe('test-hub')
    expect(body.pid, 'pid still served').toBe(4321)
  } finally {
    await srv.close()
  }
})

// The desktop client decides whether to OFFER a sign-in from this bit, and it
// has to do so before it holds a token — so it must survive the loopback gate
// (an off-box hub is exactly the one that gates).
test('authRequired is public — served to loopback and non-loopback alike', async () => {
  const srv = await startHealthServer({ authRequired: true })
  try {
    expect((await getHealth(srv.port)).body.authRequired, 'loopback sees it').toBe(true)
  } finally {
    await srv.close()
  }
  const external = await nonLoopbackAddress()
  if (!external) {
    console.log('    (non-loopback leg skipped — host has no non-loopback IPv4)')
    return
  }
  const wide = await startHealthServer({ authRequired: true }, '0.0.0.0')
  try {
    expect(
      (await getHealth(wide.port, external)).body.authRequired,
      'off-box caller sees it too'
    ).toBe(true)
  } finally {
    await wide.close()
  }
})

// O1: every switch is reported, to any caller — a client needs to know what the
// hub offers (password? SSO?) before it has signed in. Booleans only.
test('every switch is reported, to loopback and non-loopback callers alike', async () => {
  const switches = {
    requireLogin: true,
    enablePassword: false,
    enableSso: true,
    enableProcesses: false,
    enableIntegrations: false
  }
  const srv = await startHealthServer({ authRequired: true, switches })
  try {
    const body = (await getHealth(srv.port)).body
    expect(JSON.stringify(body.switches), 'loopback sees the switches').toBe(
      JSON.stringify(switches)
    )
    expect(JSON.stringify(body), 'no secret anywhere in the payload').not.toContain('ecret')
  } finally {
    await srv.close()
  }
  const external = await nonLoopbackAddress()
  if (!external) {
    console.log('    (non-loopback leg skipped — host has no non-loopback IPv4)')
    return
  }
  const wide = await startHealthServer({ authRequired: true, switches }, '0.0.0.0')
  try {
    expect(
      JSON.stringify((await getHealth(wide.port, external)).body.switches),
      'off-box caller sees them too'
    ).toBe(JSON.stringify(switches))
  } finally {
    await wide.close()
  }
})

test('authRequired=false on a non-gating hub (no sign-in offered)', async () => {
  const srv = await startHealthServer()
  try {
    expect((await getHealth(srv.port)).body.authRequired, 'authRequired=false').toBe(false)
  } finally {
    await srv.close()
  }
})

test('non-GET and other paths are not health requests', async () => {
  const srv = await startHealthServer()
  try {
    const post = await fetch(`http://127.0.0.1:${srv.port}/health`, { method: 'POST' })
    expect(post.status, 'POST /health falls through').toBe(404)
    const other = await fetch(`http://127.0.0.1:${srv.port}/nope`)
    expect(other.status, 'other path falls through').toBe(404)
  } finally {
    await srv.close()
  }
})
