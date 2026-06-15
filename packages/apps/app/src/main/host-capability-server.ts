import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import { capabilityBridgeRouter } from '@slayzone/transport/server'
import type { SlayzoneDb } from '@slayzone/platform'

/**
 * Host-side capability bridge server (slice 9 local cutover).
 *
 * The renderer connects ONLY to the side-car. Electron-only capabilities
 * (browser-WCV, clipboard, dialogs, backup, task-windows, floating-agent,
 * native menus, …) can only run here in the Electron host, so the side-car
 * forwards them over `capabilityBridgeRouter` served on this loopback WS, and
 * host-originated events (native menus, power-resume) stream back through it.
 *
 * The bridge procedures resolve `getAppDeps()`/`getMenuEvents()`/
 * `getPowerResumeEvents()` from the transport registries — the host's REAL
 * impls (wired via `setAppDeps()` before this server starts). They ignore the
 * tRPC context, but `createContext` must satisfy the router's context type, so
 * we thread the host db + dataRoot through.
 */
export type HostCapabilityServerHandle = {
  /** OS-assigned bound port. Advertise as `ws://127.0.0.1:<port>/cap`. */
  port: number
  stop: () => Promise<void>
}

export async function startHostCapabilityServer(opts: {
  db: SlayzoneDb
  dataRoot: string
  host?: string
}): Promise<HostCapabilityServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const httpServer = createServer((_req, res) => {
    res.writeHead(426)
    res.end('capability bridge: WS only')
  })

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
      await new Promise<void>((r) => httpServer.close(() => r()))
    }
  }
}
