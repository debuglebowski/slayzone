/**
 * mcp_server_port non-clobber guard (plans/sidecar-staleness.md, Phase 4).
 *
 * Reproduces the exact mistake made while validating this plan live: a
 * one-off process (a manual smoke test, a rogue standalone launch) opens the
 * SAME db as a live supervised sidecar and, with the old unconditional write,
 * overwrote `mcp_server_port` with its own throwaway port — breaking CLI/agent
 * discovery of the real backend. claimMcpServerPort() must refuse to clobber a
 * value that still answers /health.
 *
 * Pure Node (real ephemeral HTTP servers, an in-memory fake db) — no native
 * deps, runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/apps/server/src/port-claim.test.ts
 */
import http from 'node:http'
import net from 'node:net'
import {
  claimFleetServerPort,
  claimMcpServerPort,
  resolveDesiredFleetPort
} from './port-claim.js'

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

/** In-memory fake covering only what claimMcpServerPort needs. */
function fakeDb(initial?: string): {
  get: (sql: string) => Promise<{ value?: string } | undefined>
  prepare: (sql: string) => { run: (...params: unknown[]) => Promise<unknown> }
  written: string[]
} {
  let value = initial
  const written: string[] = []
  return {
    written,
    get: async () => (value !== undefined ? { value } : undefined),
    prepare: () => ({
      run: async (...params: unknown[]) => {
        value = String(params[0])
        written.push(value)
      }
    })
  }
}

/** A minimal /health server that answers 200 — simulates a live sidecar. */
function startFakeAlive(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) })
    })
  })
}

/** Finds a port nothing is listening on (probe-then-close, no leftover bind). */
function findDeadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function main(): Promise<void> {
  console.log('\nclaimMcpServerPort (non-clobber guard)')
  console.log('─'.repeat(40))

  await test('no existing value ⇒ writes freely', async () => {
    const db = fakeDb(undefined)
    const logs: string[] = []
    await claimMcpServerPort(db, '127.0.0.1', 4001, (l) => logs.push(l))
    assertEq(db.written.length, 1, 'one write')
    assertEq(db.written[0], '4001', 'wrote the new port')
  })

  await test('existing value === actualPort ⇒ writes (no-op value, still fine)', async () => {
    const db = fakeDb('4001')
    await claimMcpServerPort(db, '127.0.0.1', 4001, () => {})
    assertEq(db.written[0], '4001', 'rewrote same value')
  })

  await test('existing value points at a DEAD port ⇒ safe to overwrite', async () => {
    const deadPort = await findDeadPort()
    const db = fakeDb(String(deadPort))
    await claimMcpServerPort(db, '127.0.0.1', 4002, () => {})
    assertEq(db.written[0], '4002', 'overwrote — old value was not alive')
  })

  await test('existing value points at a LIVE sidecar ⇒ refuses to clobber', async () => {
    const alive = await startFakeAlive()
    try {
      const db = fakeDb(String(alive.port))
      const logs: string[] = []
      await claimMcpServerPort(db, '127.0.0.1', 4003, (l) => logs.push(l))
      assertEq(db.written.length, 0, 'did NOT write — a live sidecar already owns the key')
      assert(
        logs.some((l) => l.includes('refus') || l.includes('alive')),
        'logged a loud reason for refusing'
      )
    } finally {
      await alive.close()
    }
  })

  // --- Fleet port: stable claim-once-and-persist (Wave3.5-D5) ----------------
  console.log('\nresolveDesiredFleetPort (env > persisted > 0)')
  console.log('─'.repeat(40))

  await test('explicit env override wins over a persisted value', async () => {
    const db = fakeDb('51001') // a stored port that must be ignored
    assertEq(await resolveDesiredFleetPort(db, '52002'), 52002, 'env value used')
  })

  await test('a malformed env override falls to 0 (not the stored value)', async () => {
    const db = fakeDb('51001')
    assertEq(await resolveDesiredFleetPort(db, 'not-a-port'), 0, 'bad env ⇒ 0')
    assertEq(await resolveDesiredFleetPort(db, '70000'), 0, 'out-of-range env ⇒ 0')
  })

  await test('no env ⇒ reuses the persisted stable port', async () => {
    const db = fakeDb('51001')
    assertEq(await resolveDesiredFleetPort(db, undefined), 51001, 'stored port reused')
    assertEq(await resolveDesiredFleetPort(db, ''), 51001, 'empty env treated as unset')
  })

  await test('no env + no stored value ⇒ 0 (OS-assigned, fresh claim)', async () => {
    const db = fakeDb(undefined)
    assertEq(await resolveDesiredFleetPort(db, undefined), 0, 'nothing stored ⇒ 0')
  })

  await test('a garbage stored value ⇒ 0 (OS-assigned)', async () => {
    assertEq(await resolveDesiredFleetPort(fakeDb('nonsense'), undefined), 0, 'bad stored ⇒ 0')
    assertEq(await resolveDesiredFleetPort(fakeDb('0'), undefined), 0, 'stored 0 ⇒ 0')
    assertEq(await resolveDesiredFleetPort(fakeDb('99999'), undefined), 0, 'out-of-range ⇒ 0')
  })

  console.log('\nclaimFleetServerPort (persist + non-clobber guard)')
  console.log('─'.repeat(40))

  await test('no existing value ⇒ persists the bound port', async () => {
    const db = fakeDb(undefined)
    await claimFleetServerPort(db, '127.0.0.1', 51001, () => {})
    assertEq(db.written.length, 1, 'one write')
    assertEq(db.written[0], '51001', 'persisted the bound port')
  })

  await test('same value ⇒ harmless no-op rewrite (the reuse path)', async () => {
    const db = fakeDb('51001')
    await claimFleetServerPort(db, '127.0.0.1', 51001, () => {})
    assertEq(db.written[0], '51001', 'rewrote same value')
  })

  await test('stored value points at a DEAD port ⇒ safe to overwrite', async () => {
    const deadPort = await findDeadPort()
    const db = fakeDb(String(deadPort))
    await claimFleetServerPort(db, '127.0.0.1', 52002, () => {})
    assertEq(db.written[0], '52002', 'overwrote — old fleet port had no live listener')
  })

  await test('stored value has a LIVE listener ⇒ refuses to clobber', async () => {
    const alive = await startFakeAlive() // any TCP listener answers the connect probe
    try {
      const db = fakeDb(String(alive.port))
      const logs: string[] = []
      await claimFleetServerPort(db, '127.0.0.1', 52003, (l) => logs.push(l))
      assertEq(db.written.length, 0, 'did NOT write — a live listener owns the stored port')
      assert(
        logs.some((l) => l.includes('refus') || l.includes('live')),
        'logged a loud reason for refusing'
      )
    } finally {
      await alive.close()
    }
  })

  await test('force ⇒ overwrites even a stored LIVE port (post-pinned-bind-failure re-claim)', async () => {
    // The critical fix: when a pinned bind FAILED and we fell back to a fresh
    // OS-assigned port, the stored (conflicting) port is STILL live — the guard
    // would refuse and the fleet URL would churn every boot. `force` must persist
    // the new port anyway so the credential key stabilizes on the next boot.
    const alive = await startFakeAlive()
    try {
      const db = fakeDb(String(alive.port))
      await claimFleetServerPort(db, '127.0.0.1', 52099, () => {}, { force: true })
      assertEq(db.written.length, 1, 'wrote despite the stored port being live')
      assertEq(db.written[0], '52099', 'persisted the OS-assigned fallback port')
    } finally {
      await alive.close()
    }
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
