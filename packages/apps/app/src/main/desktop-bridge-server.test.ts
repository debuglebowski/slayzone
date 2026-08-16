/**
 * `/cap` bearer gate (Phase 2 follow-up — plan's open question #5).
 *
 * Loopback is NOT a trust boundary for this listener: the whole threat is
 * another process on the SAME box, also loopback, finding the ephemeral
 * port and getting the full Electron `AppDeps` (clipboard, dialogs,
 * `credentialCipher`, arbitrary webview JS execution, native menus). So the
 * gate must reject the WS handshake ITSELF (`verifyClient`) — never merely
 * attribute an unauthenticated context, since `capabilityBridgeRouter`'s
 * procedures are plain `publicProcedure` with nothing to gate on.
 *
 * Drives a REAL `startDesktopBridgeServer()` listener with a REAL `ws` client
 * socket — the handshake-level rejection this test pins can't be observed
 * through a tRPC client, which never surfaces "the upgrade itself failed" as
 * anything but a generic connection error.
 *
 * Pure Node (no electron/native deps — see app-deps.ts's own "import type
 * only" discipline) → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/apps/app/src/main/desktop-bridge-server.test.ts
 */
import { WebSocket } from 'ws'
import { startDesktopBridgeServer, type DesktopBridgeServerHandle } from './desktop-bridge-server'

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

/** Attempt a raw WS connect to `/cap`, resolving with how it ended — never
 *  throwing, so both accept and reject paths are plain return values. */
function attemptConnect(
  port: number,
  query: string
): Promise<
  { kind: 'open' } | { kind: 'rejected'; status: number } | { kind: 'error'; message: string }
> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/cap${query}`)
    let resolved = false
    const finish = (result: Awaited<ReturnType<typeof attemptConnect>>): void => {
      if (resolved) return
      resolved = true
      // A no-op catch-all so `terminate()` on a not-yet-established socket
      // can't surface as an unhandled 'error' — do NOT strip the `once`
      // handlers below first; that removed the very listener meant to catch
      // terminate()'s own deferred error emission.
      ws.on('error', () => {
        /* swallowed — already resolved */
      })
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    ws.once('open', () => finish({ kind: 'open' }))
    ws.once('unexpected-response', (_req, res) =>
      finish({ kind: 'rejected', status: res.statusCode })
    )
    ws.once('error', (err) => finish({ kind: 'error', message: err.message }))
  })
}

async function main(): Promise<void> {
  console.log('\n/cap bearer gate (desktop-bridge-server)\n')

  let handle: DesktopBridgeServerHandle | null = null
  try {
    handle = await startDesktopBridgeServer({})
    const { port, token } = handle

    await test('two servers mint DIFFERENT per-boot tokens', async () => {
      const second = await startDesktopBridgeServer({})
      try {
        assert(second.token !== token, `tokens must differ: ${second.token} vs ${token}`)
      } finally {
        await second.stop()
      }
    })

    await test('no token at all → upgrade rejected (401), socket never opens', async () => {
      const result = await attemptConnect(port, '')
      assert(
        result.kind === 'rejected' && result.status === 401,
        `expected rejected/401, got ${JSON.stringify(result)}`
      )
    })

    await test('wrong token → upgrade rejected (401)', async () => {
      const result = await attemptConnect(port, '?token=not-the-right-one')
      assert(
        result.kind === 'rejected' && result.status === 401,
        `expected rejected/401, got ${JSON.stringify(result)}`
      )
    })

    await test('right token but WRONG LENGTH → rejected, not a crash', async () => {
      // Regression guard: timingSafeEqual throws on unequal-length buffers.
      // The length check must run first so a short/long guess degrades to a
      // clean 401 instead of crashing the verifyClient callback (which would
      // hang the client forever with no response at all).
      const result = await attemptConnect(port, `?token=${token}extra`)
      assert(
        result.kind === 'rejected' && result.status === 401,
        `expected rejected/401, got ${JSON.stringify(result)}`
      )
    })

    await test('correct token → handshake succeeds', async () => {
      const result = await attemptConnect(port, `?token=${encodeURIComponent(token)}`)
      assert(result.kind === 'open', `expected open, got ${JSON.stringify(result)}`)
    })

    await test('malformed request url → rejected, not a crash', async () => {
      // `new URL(...)` inside verifyClient must not throw past the handler on a
      // pathological url — same "degrade to 401" requirement as the length case.
      const result = await attemptConnect(port, '?token=%')
      assert(
        result.kind === 'rejected' && result.status === 401,
        `expected rejected/401, got ${JSON.stringify(result)}`
      )
    })
  } finally {
    if (handle) await handle.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
