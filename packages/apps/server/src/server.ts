import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import {
  appRouter,
  createMcpRestApp,
  parseAuthCallbackUrl,
  getAuthEvents
} from '@slayzone/transport/server'
import { ensureDataRoot, getServerHost, getTrpcPort } from '@slayzone/platform'
import {
  getDatabasePathFromEnv,
  openServerDatabase,
  openServerDiagnosticsDatabase
} from './db.js'
import { composeServer } from './composition.js'
import { startSidecarSocketServer, type SidecarSocketServer } from './sidecar-socket.js'
import { handleHealth, type HealthState } from './health.js'
import { getServerBuildInfo } from './build-info.js'
import { createLogger } from './log.js'
import { claimMcpServerPort } from './port-claim.js'
import { recordDiagnosticEvent, flushWriteQueue } from '@slayzone/diagnostics/server'
import type { ServerHandle, StartServerConfig } from './index.js'

/**
 * REST routes whose handlers need Electron (live WebContents / offscreen
 * renderer) — they can't run in this plain-node side-car. When supervised, the
 * host runs a REST server with those slots wired, and we reverse-proxy these
 * route groups there (the whole handler runs in the host; only the serializable
 * HTTP request/response crosses). `/api/open-task` + `artifacts/:id/open` stay
 * here (they emit menu events on the side-car's bus + bridge the window raise).
 */
function needsHostRest(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false
  const path = rawUrl.split('?')[0]
  return path.startsWith('/api/browser/') || /^\/api\/artifacts\/[^/]+\/export\//.test(path)
}

/** Pipe a request to the host REST server and pipe its response back. */
function proxyToHostRest(hostRestUrl: string, req: IncomingMessage, res: ServerResponse): void {
  const target = new URL(hostRestUrl)
  const proxyReq = httpRequest(
    {
      host: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    }
  )
  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'host-rest-proxy-failed', message: String(err) }))
  })
  req.pipe(proxyReq)
}

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

  // Separate diagnostics events DB so THIS process's recordDiagnosticEvent calls
  // (pty + agent pool run here) persist + are queryable, instead of buffering +
  // dropping. Always owned here (independent of cfg.db).
  const diagnosticsDb = openServerDiagnosticsDatabase()

  // Populate every transport registry BEFORE accepting connections, so the
  // first procedure call can't hit an uninitialized dep.
  const composition = composeServer({ db, dataRoot, standalone: !supervised, diagnosticsDb })
  const mcpRest = createMcpRestApp(composition.restDeps)
  log('composition wired (tRPC registries + MCP/REST app)')

  // Chromium-fork OAuth deep-link bridge. The C++ shell forwards
  // `slayzone://auth/callback` to this Unix socket (auth:deep-link); we parse the
  // code and emit it on `authEvents`, which the `app.auth.onCallback` tRPC
  // subscription fans out to the renderer. Standalone (fork) only — the Electron
  // host owns the deep-link itself, so there is no chromium shell to talk to.
  let sidecarSocket: SidecarSocketServer | null = null
  if (!supervised) {
    sidecarSocket = startSidecarSocketServer({
      log,
      onAuthDeepLink: (url) => {
        const callback = parseAuthCallbackUrl(url)
        if (callback) getAuthEvents().emit('callback', callback)
      }
    })
  }

  const state: HealthState = { ready: false, port: 0, startedAt: Date.now(), dbPath }

  // Reverse-proxy target for Electron-only REST routes (supervised). Absent when
  // truly standalone → those routes fall through to express + 501 as before.
  const hostRestUrl = process.env.SLAYZONE_HOST_REST_URL

  // Single muxed HTTP server: /health (pre-express, stays alive even if the
  // express stack wedges) + Electron-only REST reverse-proxied to the host (when
  // supervised) + /api/* + /mcp via express + /trpc WS upgrade.
  const httpServer = createServer((req, res) => {
    if (handleHealth(state, req, res)) return
    if (hostRestUrl && needsHostRest(req.url)) {
      proxyToHostRest(hostRestUrl, req, res)
      return
    }
    mcpRest.app(req, res)
  })

  // Reject cross-origin WS upgrades. The /trpc socket exposes the ENTIRE app
  // router (browser control, shell.openExternal, file ops, the auth callback
  // relay) — a drive-by web page (or a DNS-rebind to 127.0.0.1) must not reach
  // it. Native clients (Electron main, node tooling/e2e, the sidecar) send no
  // Origin; the app's own renderers run at chrome:// (fork), file:// ("null",
  // packaged Electron) or http://localhost (vite dev). Anything else is a
  // foreign website → 403. (Pairs with the per-flow / PKCE auth guards.)
  const isAllowedWsOrigin = (origin: string | undefined): boolean => {
    if (!origin) return true // no Origin header → non-browser client
    if (origin === 'null') return true // file:// renderers serialize to "null"
    let u: URL
    try {
      u = new URL(origin)
    } catch {
      return false
    }
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.protocol === 'devtools:') {
      return true
    }
    if (u.protocol === 'file:') return true
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1'
  }
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/trpc',
    verifyClient: ({ origin }, cb) => {
      if (isAllowedWsOrigin(origin)) cb(true)
      else cb(false, 403, 'forbidden origin')
    }
  })
  const wssHandler = applyWSSHandler({
    wss,
    router: appRouter,
    createContext: ({ req }) => {
      // Parse windowId from the WS query (?windowId=N) → ctx.windowId. Required by
      // claimSession + panel-ownership + warm-pool (warmSetProjectTabCounts) procs;
      // without it they throw "windowId required". This sidecar's applyWSSHandler
      // had omitted it (the transport ws-server parses it, but the sidecar uses THIS
      // handler) — so the whole warm-agent pool silently never fired. The renderer
      // already sends it (see main.tsx withWindowId).
      let windowId: number | null = null
      try {
        const u = new URL(req.url ?? '/', 'http://localhost')
        const wid = u.searchParams.get('windowId')
        if (wid != null) {
          const n = Number(wid)
          if (Number.isFinite(n)) windowId = n
        }
      } catch {
        /* malformed URL — leave null */
      }
      return {
        db,
        dataRoot,
        req,
        automationEngine: composition.automationEngine,
        windowId
      }
    }
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
  // Agents spawned BY this process discover their hook endpoint via this global.
  ;(globalThis as Record<string, unknown>).__mcpPort = actualPort
  // Slice 9 live cutover: the side-car is now the discoverable backend — the CLI,
  // agents, and external MCP resolve `settings.mcp_server_port` to reach HERE
  // (the host's REST runs with writePort:false). Single writer of this key —
  // guarded against clobbering a still-live sidecar (plans/sidecar-staleness.md
  // Phase 4, see port-claim.ts).
  await claimMcpServerPort(db, host, actualPort, log)
  log(`listening on http://${host}:${actualPort} (/trpc + /health + /api + /mcp)`)

  // Boot canary: records THIS process's build identity so the running sidecar's
  // code is visible in the diagnostics DB (plans/sidecar-staleness.md). Also the
  // proof that sidecar diagnostics persistence is wired (composeServer bound the
  // diagnostics DB above) — a missing sidecar.boot event ⇒ a stale sidecar.
  const build = getServerBuildInfo()
  log(`build ${build.buildId}`)
  recordDiagnosticEvent({
    level: 'info',
    source: 'server',
    event: 'sidecar.boot',
    message: `sidecar ${build.buildId} on :${actualPort}`,
    payload: {
      buildId: build.buildId,
      commit: build.commit,
      builtAt: build.builtAt,
      pid: process.pid,
      port: actualPort,
      dbPath,
      supervised
    }
  })
  // Force the batch out now: the boot canary is `info` (not the error level that
  // auto-flushes), and a sidecar that crashes/exits inside the flush window is
  // exactly the stale/crash-loop case we need it for. The sidecar's diag DB is
  // synchronous, so this drains immediately.
  await flushWriteQueue()

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
      if (sidecarSocket) {
        try {
          await sidecarSocket.close()
        } catch {
          /* ignore */
        }
      }
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
      // Drain buffered diagnostics before closing their DB — otherwise a clean
      // shutdown silently loses the tail of the write queue (batched `info`
      // events that never hit the flush interval).
      try {
        await flushWriteQueue()
      } catch {
        /* ignore */
      }
      try {
        await diagnosticsDb.close()
      } catch {
        /* ignore */
      }
      log('stopped')
    }
  }
}
