import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import type { Database } from 'better-sqlite3'
import { getServerHost, getTrpcPort } from '@slayzone/platform'
import { appRouter } from './router'
import type { TrpcContext } from './context'

let httpServer: HttpServer | null = null
let wss: WebSocketServer | null = null
let wssHandler: ReturnType<typeof applyWSSHandler> | null = null

function getPreferredPort(db: Database): number {
  const envPort = getTrpcPort()
  if (envPort !== undefined) return envPort
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'trpc_preferred_port' LIMIT 1")
      .get() as { value: string } | undefined
    const port = parseInt(row?.value ?? '', 10)
    return port >= 1024 && port <= 65535 ? port : 0
  } catch {
    return 0
  }
}

export type StartTrpcServerOpts = {
  db: Database
  dataRoot: string
}

export function startTrpcServer(opts: StartTrpcServerOpts): void {
  stopTrpcServer()

  const { db, dataRoot } = opts
  const host = getServerHost()
  const preferred = getPreferredPort(db)

  const baseContext: TrpcContext = { db, dataRoot }

  function tryListen(port: number): void {
    httpServer = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    })
    wss = new WebSocketServer({ server: httpServer, path: '/trpc' })

    wssHandler = applyWSSHandler({
      wss,
      router: appRouter,
      createContext: ({ req }) => ({ ...baseContext, req }),
    })

    httpServer.on('listening', () => {
      const addr = httpServer!.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      ;(globalThis as Record<string, unknown>).__trpcPort = actualPort
      try {
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('trpc_server_port', ?)",
        ).run(String(actualPort))
      } catch {
        /* non-fatal */
      }
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
