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
 * only" discipline).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { startDesktopBridgeServer, type DesktopBridgeServerHandle } from './desktop-bridge-server'

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
      finish({ kind: 'rejected', status: res.statusCode ?? 0 })
    )
    ws.once('error', (err) => finish({ kind: 'error', message: err.message }))
  })
}

describe('/cap bearer gate (desktop-bridge-server)', () => {
  let handle: DesktopBridgeServerHandle | null = null
  let port: number
  let token: string
  beforeAll(async () => {
    handle = await startDesktopBridgeServer({})
    ;({ port, token } = handle)
  })
  afterAll(async () => {
    if (handle) await handle.stop()
  })

  test('two servers mint DIFFERENT per-boot tokens', async () => {
    const second = await startDesktopBridgeServer({})
    try {
      expect(second.token, 'tokens must differ').not.toBe(token)
    } finally {
      await second.stop()
    }
  })

  test('no token at all → upgrade rejected (401), socket never opens', async () => {
    expect(await attemptConnect(port, '')).toEqual({ kind: 'rejected', status: 401 })
  })

  test('wrong token → upgrade rejected (401)', async () => {
    expect(await attemptConnect(port, '?token=not-the-right-one')).toEqual({
      kind: 'rejected',
      status: 401
    })
  })

  test('right token but WRONG LENGTH → rejected, not a crash', async () => {
    // Regression guard: timingSafeEqual throws on unequal-length buffers.
    // The length check must run first so a short/long guess degrades to a
    // clean 401 instead of crashing the verifyClient callback (which would
    // hang the client forever with no response at all).
    expect(await attemptConnect(port, `?token=${token}extra`)).toEqual({
      kind: 'rejected',
      status: 401
    })
  })

  test('correct token → handshake succeeds', async () => {
    expect(await attemptConnect(port, `?token=${encodeURIComponent(token)}`)).toEqual({
      kind: 'open'
    })
  })

  test('malformed request url → rejected, not a crash', async () => {
    // `new URL(...)` inside verifyClient must not throw past the handler on a
    // pathological url — same "degrade to 401" requirement as the length case.
    expect(await attemptConnect(port, '?token=%')).toEqual({ kind: 'rejected', status: 401 })
  })
})
