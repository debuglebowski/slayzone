import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import { capabilityBridgeRouter } from '@slayzone/transport/server'

/**
 * Desktop-side bridge server (slice 9 local cutover; cap+REST merged).
 *
 * The renderer connects ONLY to the side-car. Electron-only work can only run
 * here in the Electron desktop app, and the side-car reaches it over ONE
 * loopback listener, advertised as `SLAYZONE_DESKTOP_BRIDGE_ADDRESS`:
 *
 *  • WS `/cap` — the side-car forwards Electron-only capability *method calls*
 *    (browser-WCV, clipboard, dialogs, backup, task-windows, floating-agent,
 *    native menus, …) over `capabilityBridgeRouter`, and desktop-originated
 *    events (native menus, power-resume, theme) stream back through it.
 *
 * That is now the ONLY thing it serves. It used to also host `/api/*` as a
 * reverse-proxy target for REST routes the side-car couldn't run itself — which
 * required handing it a live `SlayzoneDb`, because those handlers read the very
 * tables the side-car owns. Inverting them (handler stays with the data, only the
 * Electron step crosses) removed both the proxy and the database handle.
 *
 * The bridge procedures resolve `getAppDeps()`/`getMenuEvents()`/
 * `getPowerResumeEvents()` from the transport registries — the desktop's REAL
 * impls, wired via `setAppDeps()` before this server starts.
 *
 * AUTH: loopback is NOT a trust boundary for this listener — the whole threat
 * this gate closes is "another process on the SAME box, also loopback,
 * finding this ephemeral port" (the plan's own open question: any local
 * process that finds `/cap` got the full Electron `AppDeps` — clipboard,
 * dialogs, `credentialCipher`, arbitrary webview JS execution). So every
 * connection must present a per-boot random bearer, checked at the WS
 * upgrade itself (`verifyClient`, not merely attributed in `createContext`)
 * so an unauthenticated peer never completes a handshake at all. The token
 * is generated fresh each start, held only in memory, and handed to the ONE
 * legitimate client (this app's own side-car spawn) via
 * `SLAYZONE_DESKTOP_BRIDGE_TOKEN` — `secret`-scoped in `ENV_MANIFEST` so
 * `sanitizeSpawnEnv` strips it before any user terminal / agent child.
 */
export type DesktopBridgeServerHandle = {
  /** OS-assigned bound port. Advertise as the authority `127.0.0.1:<port>` (WS on `/cap`). */
  port: number
  /** Per-boot random bearer required as `?token=` on every `/cap` connection. */
  token: string
  stop: () => Promise<void>
}

/** Constant-time bearer check. Length is compared first so mismatched sizes
 *  never reach `timingSafeEqual` (which throws on unequal-length buffers)
 *  without leaking more than "wrong length" via the early return. */
function isValidToken(expected: Buffer, candidate: string | null): boolean {
  if (!candidate) return false
  const candidateBuf = Buffer.from(candidate)
  if (candidateBuf.length !== expected.length) return false
  return timingSafeEqual(candidateBuf, expected)
}

export async function startDesktopBridgeServer(opts: {
  host?: string
}): Promise<DesktopBridgeServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const token = randomBytes(32).toString('hex')
  const tokenBuf = Buffer.from(token)

  // Bare listener — no express app. The `/api/*` reverse-proxy target is gone:
  // every route that used to be proxied here now runs in the hub against its own
  // db and reaches back through `/cap` for the Electron step alone. Dropping it
  // also closes a real hole — this listener used to serve the ENTIRE
  // `createMcpRestApp` surface unauthenticated on loopback, with only the hub's
  // gate above the proxy keeping it honest.
  const httpServer: Server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'desktop bridge serves /cap (WS) only' }))
  })

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/cap',
    // Rejects the upgrade itself (401, socket never opens) on a missing/wrong
    // token — a real network-level deny, not just an unauthenticated context
    // downstream. `capabilityBridgeRouter`'s procedures are plain
    // `publicProcedure` (see its own docstring: it has no context to gate on,
    // by design), so the gate has to live here, not in `createContext`.
    verifyClient: (info, callback) => {
      let candidate: string | null = null
      try {
        candidate = new URL(info.req.url ?? '/', 'http://localhost').searchParams.get('token')
      } catch {
        candidate = null
      }
      if (isValidToken(tokenBuf, candidate)) {
        callback(true)
      } else {
        callback(false, 401, 'Unauthorized')
      }
    }
  })
  const handler = applyWSSHandler({
    wss,
    router: capabilityBridgeRouter,
    // Empty by construction: the bridge router has its own context type and
    // resolves everything from the AppDeps registries. No database reaches here.
    createContext: () => ({})
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown): void => {
      httpServer.off('error', onError)
      reject(err)
    }
    httpServer.once('error', onError)
    httpServer.listen(0, host, () => {
      httpServer.off('error', onError)
      resolve()
    })
  })

  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  return {
    port,
    token,
    stop: async () => {
      try {
        handler.broadcastReconnectNotification()
      } catch {
        /* ignore */
      }
      try {
        wss.close()
      } catch {
        /* ignore */
      }
      await new Promise<void>((r) => httpServer.close(() => r()))
    }
  }
}
