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
import { claimMcpServerPort } from './port-claim.js'

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

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
