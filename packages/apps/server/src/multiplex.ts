import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import { appRouter, type TrpcContext, type TrpcServerDeps } from '@slayzone/transport/server'
import type express from 'express'

export interface MultiplexOpts {
  expressApp: express.Express
  trpcDeps: TrpcServerDeps
  host: string
  port: number
}

export interface MultiplexHandle {
  server: HttpServer
  port: number
  /** Resolves once the server is listening. */
  ready: Promise<void>
  close(): Promise<void>
}

export function startMultiplex(opts: MultiplexOpts): MultiplexHandle {
  const { expressApp, trpcDeps, host, port } = opts

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    expressApp(req, res)
  })

  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (url.pathname === '/trpc') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })

  const wssHandler = applyWSSHandler({
    wss,
    router: appRouter,
    createContext: ({ req }): TrpcContext => {
      let windowId: number | null = null
      try {
        const u = new URL(req.url ?? '/', `http://${host}`)
        const wid = u.searchParams.get('windowId')
        if (wid != null) {
          const n = Number(wid)
          if (Number.isFinite(n)) windowId = n
        }
      } catch {
        /* malformed url */
      }
      return { ...trpcDeps, req, windowId }
    },
  })

  let actualPort = port
  const ready = new Promise<void>((resolve, reject) => {
    httpServer.once('listening', () => {
      const addr = httpServer.address()
      if (typeof addr === 'object' && addr) actualPort = addr.port
      resolve()
    })
    httpServer.once('error', reject)
  })

  httpServer.listen(port, host)

  return {
    server: httpServer,
    get port() { return actualPort },
    ready,
    async close(): Promise<void> {
      try {
        wssHandler.broadcastReconnectNotification()
      } catch {
        /* ignore */
      }
      try {
        wss.close()
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
    },
  }
}
