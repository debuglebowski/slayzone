import { createServer, type Server } from 'node:http'
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
 */
export type DesktopBridgeServerHandle = {
  /** OS-assigned bound port. Advertise as the authority `127.0.0.1:<port>` (WS on `/cap`). */
  port: number
  stop: () => Promise<void>
}

export async function startDesktopBridgeServer(opts: {
  host?: string
}): Promise<DesktopBridgeServerHandle> {
  const host = opts.host ?? '127.0.0.1'

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

  const wss = new WebSocketServer({ server: httpServer, path: '/cap' })
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
