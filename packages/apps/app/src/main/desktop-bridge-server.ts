import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import {
  capabilityBridgeRouter,
  createMcpRestApp,
  type McpRestAppHandle,
  type RestApiDeps
} from '@slayzone/transport/server'
import type { SlayzoneDb } from '@slayzone/platform'

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
 *  • HTTP `/api/*` — the REST routes whose handlers need a live WebContents /
 *    offscreen renderer (browser-automation + artifact export). The side-car
 *    reverse-proxies just those route groups here.
 *
 * The bridge procedures resolve `getAppDeps()`/`getMenuEvents()`/
 * `getPowerResumeEvents()` from the transport registries — the desktop's REAL
 * impls (wired via `setAppDeps()` before this server starts). They ignore the
 * tRPC context, but `createContext` must satisfy the router's context type, so
 * we thread the desktop db + dataRoot through.
 */
export type DesktopBridgeServerHandle = {
  /** OS-assigned bound port. Advertise as the authority `127.0.0.1:<port>` (WS on `/cap`). */
  port: number
  stop: () => Promise<void>
}

export async function startDesktopBridgeServer(opts: {
  db: SlayzoneDb
  dataRoot: string
  /** REST deps for the Electron-only `/api/*` routes the side-car proxies here. */
  restDeps: RestApiDeps
  host?: string
}): Promise<DesktopBridgeServerHandle> {
  const host = opts.host ?? '127.0.0.1'

  // The REST/MCP express app carries every HTTP request; the capability bridge
  // rides the same listener as a WS upgrade scoped to `/cap`.
  const restApp: McpRestAppHandle = createMcpRestApp(opts.restDeps)
  const httpServer: Server = createServer(restApp.app)

  const wss = new WebSocketServer({ server: httpServer, path: '/cap' })
  const handler = applyWSSHandler({
    wss,
    router: capabilityBridgeRouter,
    createContext: () => ({ db: opts.db, dataRoot: opts.dataRoot })
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
      try {
        restApp.dispose()
      } catch {
        /* ignore */
      }
      await new Promise<void>((r) => httpServer.close(() => r()))
    }
  }
}
