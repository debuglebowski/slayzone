import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import {
  appRouter,
  createMcpRestApp,
  parseAuthCallbackUrl,
  getAuthEvents
} from '@slayzone/transport/server'
import { createAuthExpressApp } from '@slayzone/hub-auth/server'
import { loadOrCreateHubIdentity } from '@slayzone/hub-identity/server'
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

  // --- Fleet mode (hub/runner split, wave 2B) --------------------------------
  // `composition.fleetReady` resolves the async fleet init (createHubAuth runs
  // better-auth migrations). It is an already-resolved no-op when fleet mode is
  // off, so awaiting it is invisible on the default path — no listener, no
  // identity load, no mount happens below when the gateway/auth are null.
  await composition.fleetReady
  const fleetGateway = composition.fleetGateway
  const hubAuth = composition.hubAuth
  // better-auth express app for `/api/auth/*`. Mounted via a direct dispatch in
  // the HTTP request handler BELOW (not inside the mcpRest express app) so the
  // RAW request body reaches better-auth — mcpRest applies `express.json()`,
  // which would consume the body before better-auth sees it.
  const authApp = hubAuth ? createAuthExpressApp(hubAuth) : null
  // Hub TLS identity — loaded only under fleet mode (creates <dataRoot>/identity/
  // on first run). For THIS unit its `fingerprintSha256Hex` is fed to the runners
  // registry so `mintJoinToken` can pin it in a join token; the fleet WS listener
  // itself stays plain `ws` on the shared HTTP server (see the demux below).
  // TLS TERMINATION + actual cert-pinning ENFORCEMENT is DEFERRED to a follow-up:
  // upgrading the muxed HTTP server to https risks the shared /trpc + /health +
  // /mcp + REST-proxy stack, so we do not half-wire it here (the join token
  // already carries the correct fingerprint for when TLS lands).
  const hubIdentity = fleetGateway ? await loadOrCreateHubIdentity(dataRoot) : null
  if (fleetGateway) log('fleet mode enabled (gateway + hub-auth + identity loaded)')

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
  // supervised) + `/api/auth/*` → hub-auth (fleet mode only, RAW body) + /api/*
  // + /mcp via express + /trpc WS upgrade.
  const httpServer = createServer((req, res) => {
    if (handleHealth(state, req, res)) return
    if (hostRestUrl && needsHostRest(req.url)) {
      proxyToHostRest(hostRestUrl, req, res)
      return
    }
    // Fleet mode: `/api/auth/*` goes to the hub-auth express app BEFORE the
    // mcpRest stack, which applies `express.json()` — better-auth needs the raw
    // body. Absent when fleet mode is off, so the default path is unchanged.
    if (authApp && (req.url ?? '').split('?')[0].startsWith('/api/auth/')) {
      authApp(req, res)
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
  const verifyTrpcClient = (
    { origin }: { origin?: string },
    cb: (verified: boolean, code?: number, message?: string) => void
  ): void => {
    if (isAllowedWsOrigin(origin)) cb(true)
    else cb(false, 403, 'forbidden origin')
  }
  // Fleet mode: the shared HTTP server must carry BOTH `/trpc` (browser renderer,
  // origin-guarded) and `/fleet` (non-browser runners, authenticated via
  // enroll/hello + join token, NOT Origin). A single `WebSocketServer({ server,
  // path })` would `abortHandshake(400)` the other path, so we run both in
  // `noServer` mode and demux upgrades ourselves. Default (fleet off) keeps the
  // exact original single-WSS construction → byte-identical behavior.
  let wss: WebSocketServer
  let fleetWss: WebSocketServer | null = null
  if (fleetGateway) {
    wss = new WebSocketServer({ noServer: true, verifyClient: verifyTrpcClient })
    fleetWss = new WebSocketServer({ noServer: true })
    httpServer.on('upgrade', (req, socket, head) => {
      const pathname = (req.url ?? '').split('?')[0]
      if (pathname === '/trpc') {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      } else if (pathname === '/fleet') {
        // No origin allowlist here — runners are non-browser clients that
        // authenticate via the fleet protocol (enroll/hello frames + join token),
        // not Origin. TLS/cert-pinning is deferred (see hubIdentity note above);
        // this is plain `ws` on the shared server for now.
        fleetWss!.handleUpgrade(req, socket, head, (ws) => fleetGateway.handleConnection(ws))
      } else {
        socket.destroy()
      }
    })
  } else {
    wss = new WebSocketServer({
      server: httpServer,
      path: '/trpc',
      verifyClient: verifyTrpcClient
    })
  }
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
  // Fleet mode: now that the port is bound + the identity is loaded, feed the
  // fleet WS URL + cert fingerprint to the runners registry so `mintJoinToken`
  // can embed them. Plain `ws://` for now (TLS deferred — see hubIdentity note);
  // the fingerprint is still the real one, so a future TLS listener can pin it.
  if (fleetGateway && hubIdentity) {
    composition.setFleetListenerInfo({
      hubUrl: `ws://${host}:${actualPort}/fleet`,
      certFingerprint: hubIdentity.fingerprintSha256Hex
    })
    log(`fleet listener ready on ws://${host}:${actualPort}/fleet`)
  }
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
      // Fleet mode: terminate every runner connection + reject in-flight requests,
      // then close the fleet WSS. No-op when fleet mode is off (both are null).
      if (fleetGateway) {
        try {
          fleetGateway.close()
        } catch {
          /* ignore */
        }
      }
      if (fleetWss) {
        try {
          fleetWss.close()
        } catch {
          /* ignore */
        }
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
