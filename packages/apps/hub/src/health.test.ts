/**
 * `/health` identity + loopback gating (plans/hub-lifecycle-and-discovery.md,
 * Phase 1).
 *
 * `/health` is the sole discovery channel for `slay hub ls` — it must carry
 * enough identity to name a hub (name/root/pid/mode/supervised/runners) without
 * any shared state. And because a hub may bind wider than loopback, the fields
 * that describe the FILESYSTEM (root, dbPath) or the process (pid) must be
 * withheld from non-loopback callers: today `dbPath` is served to anyone who can
 * reach the port.
 *
 * Pure Node (real ephemeral HTTP servers, no native deps) → runs under plain
 * `npx tsx`.
 *
 * Run with: npx tsx packages/apps/hub/src/health.test.ts
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleHealth, type HealthState } from './health.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn()
    .then(() => {
      console.log(`  ✓ ${name}`)
      passed++
    })
    .catch((e) => {
      console.error(`  ✗ ${name}`)
      console.error(`    ${e instanceof Error ? e.message : e}`)
      failed++
    })
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

const BASE_STATE: Omit<HealthState, 'ready'> = {
  port: 51110,
  startedAt: Date.now() - 5_000,
  dbPath: '/tmp/slz-test-root/storage/slayzone.sqlite',
  name: 'test-hub',
  root: '/tmp/slz-test-root',
  pid: 4321,
  mode: 'local',
  supervised: false,
  runnersConnected: () => 2
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
  host = '127.0.0.1'
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://${host}:${port}/health`)
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

async function main(): Promise<void> {
  console.log('\n/health identity + loopback gating\n')

  await test('503 while not ready, and leaks nothing', async () => {
    const srv = await startHealthServer({ ready: false })
    try {
      const { status, body } = await getHealth(srv.port)
      assertEq(status, 503, 'not-ready status')
      assertEq(body.ok, false, 'ok=false')
      assertEq(body.dbPath, undefined, 'no dbPath before ready')
      assertEq(body.root, undefined, 'no root before ready')
    } finally {
      await srv.close()
    }
  })

  await test('loopback caller gets the full identity set', async () => {
    const srv = await startHealthServer()
    try {
      const { status, body } = await getHealth(srv.port)
      assertEq(status, 200, 'ok status')
      assertEq(body.ok, true, 'ok=true')
      // Discovery keys off these — `slay hub ls` cannot render a row without them.
      assertEq(body.name, 'test-hub', 'name')
      assertEq(body.root, '/tmp/slz-test-root', 'root')
      assertEq(body.pid, 4321, 'pid')
      assertEq(body.mode, 'local', 'mode')
      assertEq(body.supervised, false, 'supervised')
      assertEq(body.runnersConnected, 2, 'runnersConnected resolved from the getter')
      assertEq(body.dbPath, BASE_STATE.dbPath, 'dbPath')
      assertEq(body.port, 51110, 'port')
      assert(typeof body.uptimeMs === 'number' && body.uptimeMs >= 5_000, 'uptimeMs')
    } finally {
      await srv.close()
    }
  })

  await test('runnersConnected reflects the live gateway, not a boot snapshot', async () => {
    let count = 0
    const srv = await startHealthServer({ runnersConnected: () => count })
    try {
      assertEq((await getHealth(srv.port)).body.runnersConnected, 0, 'starts at 0')
      count = 3
      assertEq((await getHealth(srv.port)).body.runnersConnected, 3, 'follows the getter')
    } finally {
      await srv.close()
    }
  })

  await test('supervised=true is reported (hub ls tags it, hub stop refuses it)', async () => {
    const srv = await startHealthServer({ supervised: true })
    try {
      assertEq((await getHealth(srv.port)).body.supervised, true, 'supervised')
    } finally {
      await srv.close()
    }
  })

  await test('non-loopback caller is denied every path/process field', async () => {
    const external = await nonLoopbackAddress()
    if (!external) {
      console.log('    (skipped — host has no non-loopback IPv4)')
      return
    }
    const srv = await startHealthServer({}, '0.0.0.0')
    try {
      const { status, body } = await getHealth(srv.port, external)
      assertEq(status, 200, 'still 200 — liveness is public')
      assertEq(body.ok, true, 'ok=true')
      // Public: liveness + build identity, nothing that describes the host.
      assertEq(body.port, 51110, 'port stays public')
      assert(typeof body.uptimeMs === 'number', 'uptimeMs stays public')
      assert('buildId' in body, 'buildId stays public')
      // Withheld: absolute paths + pid. dbPath is the pre-existing leak.
      assertEq(body.dbPath, undefined, 'dbPath withheld')
      assertEq(body.root, undefined, 'root withheld')
      assertEq(body.pid, undefined, 'pid withheld')
      assertEq(body.name, undefined, 'name withheld')
      assertEq(body.runnersConnected, undefined, 'runnersConnected withheld')
    } finally {
      await srv.close()
    }
  })

  await test('non-GET and other paths are not health requests', async () => {
    const srv = await startHealthServer()
    try {
      const post = await fetch(`http://127.0.0.1:${srv.port}/health`, { method: 'POST' })
      assertEq(post.status, 404, 'POST /health falls through')
      const other = await fetch(`http://127.0.0.1:${srv.port}/nope`)
      assertEq(other.status, 404, 'other path falls through')
    } finally {
      await srv.close()
    }
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
