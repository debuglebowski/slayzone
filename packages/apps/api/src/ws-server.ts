import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import type { SlayzoneDb } from '@slayzone/platform'
import { getServerHost, getTrpcPort } from '@slayzone/platform'
import { appRouter } from './router'
import type { AutomationEngineLike, TrpcContext } from './context'

let httpServer: HttpServer | null = null
let wss: WebSocketServer | null = null
let wssHandler: ReturnType<typeof applyWSSHandler> | null = null

async function getPreferredPort(db: SlayzoneDb): Promise<number> {
  const envPort = getTrpcPort()
  if (envPort !== undefined) return envPort
  try {
    const row = await db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'trpc_preferred_port' LIMIT 1"
    )
    const port = parseInt(row?.value ?? '', 10)
    return port >= 1024 && port <= 65535 ? port : 0
  } catch {
    return 0
  }
}

export type StartTrpcServerOpts = {
  db: SlayzoneDb
  dataRoot: string
  automationEngine?: AutomationEngineLike
}

export async function startTrpcServer(opts: StartTrpcServerOpts): Promise<void> {
  stopTrpcServer()

  const { db, dataRoot, automationEngine } = opts
  const host = getServerHost()
  const preferred = await getPreferredPort(db)

  const baseContext: TrpcContext = { db, dataRoot, automationEngine }

  function tryListen(port: number): void {
    httpServer = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    })
    wss = new WebSocketServer({ server: httpServer, path: '/trpc' })

    wssHandler = applyWSSHandler({
      wss,
      router: appRouter,
      createContext: ({ req }) => {
        // Parse windowId from query string (?windowId=N). Renderer passes its
        // unique window-bound id at WS connect time; null = standalone client.
        let windowId: number | null = null
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const wid = url.searchParams.get('windowId')
          if (wid != null) {
            const n = Number(wid)
            if (Number.isFinite(n)) windowId = n
          }
        } catch {
          /* malformed URL — leave null */
        }
        return { ...baseContext, req, windowId }
      }
    })

    httpServer.on('listening', () => {
      const addr = httpServer!.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      ;(globalThis as Record<string, unknown>).__trpcPort = actualPort
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('trpc_server_port', ?)", [
        String(actualPort)
      ]).catch(() => {
        /* non-fatal */
      })
      console.log(`[tRPC] WS server listening on ws://${host}:${actualPort}/trpc`)
    })

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        console.warn(`[tRPC] Port ${port} in use, falling back to dynamic port`)
        stopTrpcServer()
        tryListen(0)
      } else {
        console.error('[tRPC] Server error:', err)
      }
    })

    httpServer.listen(port, host)
  }

  tryListen(preferred)
}

export function stopTrpcServer(): void {
  if (wssHandler) {
    wssHandler.broadcastReconnectNotification()
    wssHandler = null
  }
  if (wss) {
    wss.close()
    wss = null
  }
  if (httpServer) {
    httpServer.close()
    httpServer = null
  }
}
