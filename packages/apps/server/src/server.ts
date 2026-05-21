import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import { appRouter } from '@slayzone/transport/server'
import { ensureDataRoot, getServerHost, getTrpcPort } from '@slayzone/platform'
import { getDatabasePathFromEnv, openServerDatabase } from './db.js'
import { handleHealth, type HealthState } from './health.js'
import { createLogger } from './log.js'
import type { ServerHandle, StartServerConfig } from './index.js'

export async function startServer(cfg: StartServerConfig = {}): Promise<ServerHandle> {
  const host = cfg.host ?? getServerHost()
  const dataRoot = cfg.storeDir ?? ensureDataRoot()
  const log = createLogger(dataRoot)

  const dbPath = getDatabasePathFromEnv()
  const db = cfg.db ?? openServerDatabase()
  const ownsDb = cfg.db === undefined
  log(`db opened: ${dbPath}`)

  const state: HealthState = { ready: false, port: 0, startedAt: Date.now(), dbPath }

  const httpServer = createServer((req, res) => {
    if (handleHealth(state, req, res)) return
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  const wss = new WebSocketServer({ server: httpServer, path: '/trpc' })
  const wssHandler = applyWSSHandler({
    wss,
    router: appRouter,
    createContext: ({ req }) => ({ db, dataRoot, req })
  })

  const port = cfg.port ?? getTrpcPort() ?? 0
  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown): void => {
      httpServer.off('error', onError)
      reject(err)
    }
    httpServer.once('error', onError)
    httpServer.listen(port, host, () => {
      httpServer.off('error', onError)
      resolve()
    })
  })

  const addr = httpServer.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : port
  state.port = actualPort
  state.ready = true
  log(`listening on http://${host}:${actualPort} (/trpc + /health)`)

  let stopped = false
  return {
    port: actualPort,
    host,
    dataRoot,
    dbPath,
    healthCheck: async () => state.ready,
    stop: async () => {
      if (stopped) return
      stopped = true
      state.ready = false
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
      await new Promise<void>((r) => httpServer.close(() => r()))
      if (ownsDb) {
        try {
          db.close()
        } catch {
          /* ignore */
        }
      }
      log('stopped')
    }
  }
}
