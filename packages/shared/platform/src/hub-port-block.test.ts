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
 * Run with: npx tsx packages/shared/platform/src/hub-port-block.test.ts
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  HUB_DYNAMIC_PORT_RANGE,
  HUB_PORT_BLOCK,
  SIDECAR_FIXED_PORT,
  bindInHubPortBlock
} from './paths'

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

/** Occupies `port` so the walk has to step over it. */
function occupy(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => {
      resolve(() => new Promise((r) => srv.close(() => r())))
    })
  })
}

async function main(): Promise<void> {
  console.log('\nhub port block\n')

  await test('the dynamic range sits inside the block, after the supervised head', async () => {
    assert(HUB_DYNAMIC_PORT_RANGE.start > HUB_PORT_BLOCK.start, 'dynamic starts after block start')
    assertEq(HUB_DYNAMIC_PORT_RANGE.end, HUB_PORT_BLOCK.end, 'both end together')
    // Every fixed supervised port must fall in the RESERVED head, never in the
    // range standalone hubs draw from — else a standalone hub could take the
    // port the desktop app expects to bind.
    for (const [env, port] of Object.entries(SIDECAR_FIXED_PORT)) {
      assert(port >= HUB_PORT_BLOCK.start, `${env} inside block`)
      assert(port < HUB_DYNAMIC_PORT_RANGE.start, `${env} in the reserved head, not the dynamic range`)
    }
  })

  await test('binds the first free port in the dynamic range', async () => {
    const srv = http.createServer()
    try {
      const port = await bindInHubPortBlock(srv, '127.0.0.1')
      assert(
        port >= HUB_DYNAMIC_PORT_RANGE.start && port <= HUB_DYNAMIC_PORT_RANGE.end,
        `port ${port} is inside the dynamic range`
      )
      assertEq((srv.address() as AddressInfo).port, port, 'returned port matches the bound socket')
    } finally {
      await new Promise((r) => srv.close(() => r(undefined)))
    }
  })

  await test('steps over an occupied port instead of failing', async () => {
    const release = await occupy(HUB_DYNAMIC_PORT_RANGE.start)
    const srv = http.createServer()
    try {
      const port = await bindInHubPortBlock(srv, '127.0.0.1')
      assert(port > HUB_DYNAMIC_PORT_RANGE.start, `skipped the taken port (got ${port})`)
    } finally {
      await new Promise((r) => srv.close(() => r(undefined)))
      await release()
    }
  })

  await test('two hubs in a row get distinct ports (no shared state)', async () => {
    const a = http.createServer()
    const b = http.createServer()
    try {
      const portA = await bindInHubPortBlock(a, '127.0.0.1')
      const portB = await bindInHubPortBlock(b, '127.0.0.1')
      assert(portA !== portB, `distinct ports (${portA} vs ${portB})`)
    } finally {
      await new Promise((r) => a.close(() => r(undefined)))
      await new Promise((r) => b.close(() => r(undefined)))
    }
  })

  await test('exhausted range fails loud, naming the range', async () => {
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
      assert(message.length > 0, 'threw rather than resolving')
      assert(
        message.includes(String(HUB_DYNAMIC_PORT_RANGE.start)),
        `error names the range: ${message}`
      )
    } finally {
      await new Promise((r) => srv.close(() => r(undefined)))
      await release()
    }
  })

  await test('a non-EADDRINUSE bind error propagates instead of walking', async () => {
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
    assert(message.length > 0, 'threw')
    assert(!message.includes('no free port'), `propagated the real error, not exhaustion: ${message}`)
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
