/**
 * server_port non-clobber guard (plans/sidecar-staleness.md, Phase 4).
 *
 * Reproduces the exact mistake made while validating this plan live: a
 * one-off process (a manual smoke test, a rogue standalone launch) opens the
 * SAME db as a live supervised sidecar and, with the old unconditional write,
 * overwrote `server_port` with its own throwaway port — breaking CLI/agent
 * discovery of the real backend. claimServerPort() must refuse to clobber a
 * value that still answers /health.
 *
 * Pure Node (real ephemeral HTTP servers, an in-memory fake db) — no native
 * deps.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/hub/src/port-claim.test.ts
 */
import http from 'node:http'
import net from 'node:net'
import { expect, test } from 'vitest'
import { claimServerPort } from './port-claim.js'

/** In-memory fake covering only what claimServerPort needs. */
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

test('no existing value ⇒ writes freely', async () => {
  const db = fakeDb(undefined)
  const logs: string[] = []
  await claimServerPort(db, '127.0.0.1', 4001, (l) => logs.push(l))
  expect(db.written.length, 'one write').toBe(1)
  expect(db.written[0], 'wrote the new port').toBe('4001')
})

test('existing value === actualPort ⇒ writes (no-op value, still fine)', async () => {
  const db = fakeDb('4001')
  await claimServerPort(db, '127.0.0.1', 4001, () => {})
  expect(db.written[0], 'rewrote same value').toBe('4001')
})

test('existing value points at a DEAD port ⇒ safe to overwrite', async () => {
  const deadPort = await findDeadPort()
  const db = fakeDb(String(deadPort))
  await claimServerPort(db, '127.0.0.1', 4002, () => {})
  expect(db.written[0], 'overwrote — old value was not alive').toBe('4002')
})

test('existing value points at a LIVE sidecar ⇒ refuses to clobber', async () => {
  const alive = await startFakeAlive()
  try {
    const db = fakeDb(String(alive.port))
    const logs: string[] = []
    await claimServerPort(db, '127.0.0.1', 4003, (l) => logs.push(l))
    expect(db.written.length, 'did NOT write — a live sidecar already owns the key').toBe(0)
    expect(
      logs.some((l) => l.includes('refus') || l.includes('alive')),
      'logged a loud reason for refusing'
    ).toBe(true)
  } finally {
    await alive.close()
  }
})
