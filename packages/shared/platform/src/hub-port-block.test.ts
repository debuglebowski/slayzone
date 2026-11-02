/**
 * Hub port block allocation (plans/hub-lifecycle-and-discovery.md, Phase 3).
 *
 * Discovery works by probing a KNOWN range of loopback ports, so a standalone
 * hub that lets the OS assign an ephemeral port lands outside the range and is
 * invisible to `slay hub ls`. `bindInHubPortBlock` walks the reserved dynamic
 * range instead, taking the first free port — which also makes "N hubs on one
 * machine" collision-free without any shared state.
 *
 * Pure Node (real binds on loopback, no native deps) → runs under plain
 * `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/hub-port-block.test.ts
 */
import { describe, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  DEFAULT_HUB_PORT_BLOCK,
  HUB_DYNAMIC_PORT_RANGE,
  HUB_PORT_BLOCK,
  SIDECAR_FIXED_PORT,
  bindInHubPortBlock,
  resolveHubPortBlockStart
} from './paths'

/**
 * Occupies `port` so the walk has to step over it. The block is a fixed, shared
 * range and test files now run concurrently, so another process (a hub another
 * suite spawned, or the dev app's own) may already hold it — then it is occupied
 * already, which is all the caller needs, and there is nothing of ours to release.
 */
function occupy(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.once('error', (e: NodeJS.ErrnoException) =>
      e.code === 'EADDRINUSE' ? resolve(async () => {}) : reject(e)
    )
    srv.listen(port, '127.0.0.1', () => {
      resolve(() => new Promise((r) => srv.close(() => r())))
    })
  })
}

describe('the test-only hub port block seam', () => {
  test('unset or empty is the shipped block', () => {
    expect(resolveHubPortBlockStart(undefined)).toBe(51100)
    expect(resolveHubPortBlockStart('')).toBe(51100)
    expect(DEFAULT_HUB_PORT_BLOCK).toEqual({ start: 51100, end: 51199 })
  })

  test('a valid start moves the block there', () => {
    expect(resolveHubPortBlockStart('20000')).toBe(20000)
    expect(resolveHubPortBlockStart('65436')).toBe(65436)
  })

  test.each(['abc', '-1', '1.5', '1023', '65437', ' 20000'])('refuses malformed %j', (raw) => {
    expect(() => resolveHubPortBlockStart(raw)).toThrow(/SLAYZONE_TEST_HUB_PORT_BLOCK_START/)
  })

  // It can only ever point AWAY from where real hubs run.
  test.each(['51100', '51001', '51199', '51150'])(
    'refuses %s, which overlaps the shipped block',
    (raw) => {
      expect(() => resolveHubPortBlockStart(raw)).toThrow(/overlaps the shipped hub port block/)
    }
  )

  test('accepts the blocks right next to the shipped one', () => {
    expect(resolveHubPortBlockStart('51000')).toBe(51000)
    expect(resolveHubPortBlockStart('51200')).toBe(51200)
  })

  test('the test runner moved this run off the shipped block (caller-env.ts)', () => {
    expect(HUB_PORT_BLOCK.start).not.toBe(DEFAULT_HUB_PORT_BLOCK.start)
    expect(SIDECAR_FIXED_PORT.dev).toBe(HUB_PORT_BLOCK.start + 1)
  })
})

describe('hub port block', () => {
  test('the dynamic range sits inside the block, after the supervised head', async () => {
    expect(HUB_DYNAMIC_PORT_RANGE.start, 'dynamic starts after block start').toBeGreaterThan(
      HUB_PORT_BLOCK.start
    )
    expect(HUB_DYNAMIC_PORT_RANGE.end, 'both end together').toBe(HUB_PORT_BLOCK.end)
    // Every fixed supervised port must fall in the RESERVED head, never in the
    // range standalone hubs draw from — else a standalone hub could take the
    // port the desktop app expects to bind.
    for (const [env, port] of Object.entries(SIDECAR_FIXED_PORT)) {
      expect(port, `${env} inside block`).toBeGreaterThanOrEqual(HUB_PORT_BLOCK.start)
      expect(port, `${env} in the reserved head, not the dynamic range`).toBeLessThan(
        HUB_DYNAMIC_PORT_RANGE.start
      )
    }
  })

  test('binds the first free port in the dynamic range', async () => {
    const srv = http.createServer()
    try {
      const port = await bindInHubPortBlock(srv, '127.0.0.1')
      expect(port, `port ${port} is inside the dynamic range`).toBeGreaterThanOrEqual(
        HUB_DYNAMIC_PORT_RANGE.start
      )
      expect(port, `port ${port} is inside the dynamic range`).toBeLessThanOrEqual(
        HUB_DYNAMIC_PORT_RANGE.end
      )
      expect((srv.address() as AddressInfo).port, 'returned port matches the bound socket').toBe(
        port
      )
    } finally {
      await new Promise((r) => srv.close(() => r(undefined)))
    }
  })

  test('steps over an occupied port instead of failing', async () => {
    const release = await occupy(HUB_DYNAMIC_PORT_RANGE.start)
    const srv = http.createServer()
    try {
      const port = await bindInHubPortBlock(srv, '127.0.0.1')
      expect(port, `skipped the taken port (got ${port})`).toBeGreaterThan(
        HUB_DYNAMIC_PORT_RANGE.start
      )
    } finally {
      await new Promise((r) => srv.close(() => r(undefined)))
      await release()
    }
  })

  test('two hubs in a row get distinct ports (no shared state)', async () => {
    const a = http.createServer()
    const b = http.createServer()
    try {
      const portA = await bindInHubPortBlock(a, '127.0.0.1')
      const portB = await bindInHubPortBlock(b, '127.0.0.1')
      expect(portA, `distinct ports (${portA} vs ${portB})`).not.toBe(portB)
    } finally {
      await new Promise((r) => a.close(() => r(undefined)))
      await new Promise((r) => b.close(() => r(undefined)))
    }
  })

  test('exhausted range fails loud, naming the range', async () => {
    // A one-port window that is already taken → nothing left to try.
    const release = await occupy(HUB_DYNAMIC_PORT_RANGE.start)
    const srv = http.createServer()
    try {
      let message = ''
      try {
        await bindInHubPortBlock(srv, '127.0.0.1', {
          start: HUB_DYNAMIC_PORT_RANGE.start,
          end: HUB_DYNAMIC_PORT_RANGE.start
        })
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message.length, 'threw rather than resolving').toBeGreaterThan(0)
      expect(message, `error names the range: ${message}`).toContain(
        String(HUB_DYNAMIC_PORT_RANGE.start)
      )
    } finally {
      await new Promise((r) => srv.close(() => r(undefined)))
      await release()
    }
  })

  test('a non-EADDRINUSE bind error propagates instead of walking', async () => {
    const srv = http.createServer()
    let message = ''
    try {
      // Unassignable host → EADDRNOTAVAIL. Walking the range would retry ~90
      // times on an error that has nothing to do with the port being taken.
      await bindInHubPortBlock(srv, '203.0.113.1')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    } finally {
      await new Promise((r) => srv.close(() => r(undefined)))
    }
    expect(message.length, 'threw').toBeGreaterThan(0)
    expect(message, `propagated the real error, not exhaustion: ${message}`).not.toContain(
      'no free port'
    )
  })
})
