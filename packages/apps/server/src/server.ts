import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import { appRouter, createMcpRestApp } from '@slayzone/transport/server'
import { ensureDataRoot, getServerHost, getTrpcPort } from '@slayzone/platform'
import { getDatabasePathFromEnv, openServerDatabase } from './db.js'
import { composeServer } from './composition.js'
import { handleHealth, type HealthState } from './health.js'
import { createLogger } from './log.js'
import type { ServerHandle, StartServerConfig } from './index.js'

export async function startServer(cfg: StartServerConfig = {}): Promise<ServerHandle> {
  const host = cfg.host ?? getServerHost()
  const dataRoot = cfg.storeDir ?? ensureDataRoot()
  const log = createLogger(dataRoot)

  const supervised = process.env.SLAYZONE_SUPERVISED === '1'
  const dbPath = getDatabasePathFromEnv()
  // Standalone owns its schema (fresh stores get migrated); supervised opens
  // the Electron host's already-migrated DB and must not touch the schema.
  const db = cfg.db ?? openServerDatabase({ bootstrapSchema: !supervised })
  const ownsDb = cfg.db === undefined
  log(`db opened: ${dbPath}${supervised ? '' : ' (schema bootstrapped)'}`)

  // Populate every transport registry BEFORE accepting connections, so the
  // first procedure call can't hit an uninitialized dep.
  const composition = composeServer({ db, dataRoot, standalone: !supervised })
  const mcpRest = createMcpRestApp(composition.restDeps)
  log('composition wired (tRPC registries + MCP/REST app)')

  const state: HealthState = { ready: false, port: 0, startedAt: Date.now(), dbPath }

  // Single muxed HTTP server: /health (pre-express, stays alive even if the
  // express stack wedges) + /api/* + /mcp via express + /trpc WS upgrade.
  const httpServer = createServer((req, res) => {
    if (handleHealth(state, req, res)) return
    mcpRest.app(req, res)
  })

  const wss = new WebSocketServer({ server: httpServer, path: '/trpc' })
  const wssHandler = applyWSSHandler({
    wss,
    router: appRouter,
    createContext: ({ req }) => ({
      db,
      dataRoot,
      req,
      automationEngine: composition.automationEngine
    })
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
  composition.setBoundPort(actualPort)
  // Agents spawned BY this process discover their hook endpoint through the
  // same global the Electron host uses. Never written to settings — the
  // Electron host's live MCP port stays the discoverable one while dark.
  ;(globalThis as Record<string, unknown>).__mcpPort = actualPort
  log(`listening on http://${host}:${actualPort} (/trpc + /health + /api + /mcp)`)

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
      mcpRest.dispose()
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
          await db.close()
        } catch {
          /* ignore */
        }
      }
      log('stopped')
    }
  }
}
