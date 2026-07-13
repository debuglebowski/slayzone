import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
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
import { startFleetListener } from './fleet-listener.js'
import { startSidecarSocketServer, type SidecarSocketServer } from './sidecar-socket.js'
import { handleHealth, type HealthState } from './health.js'
import { getServerBuildInfo } from './build-info.js'
import { createLogger } from './log.js'
import { claimMcpServerPort, claimFleetServerPort, resolveDesiredFleetPort } from './port-claim.js'
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
  // on first run). Its `fingerprintSha256Hex` is fed to the runners registry so
  // `mintJoinToken` can pin it in a join token, AND its key/cert terminate TLS on
  // the SEPARATE https `/fleet` listener stood up below. Cert-pinning is enforced
  // end-to-end: the hub presents this leaf, the runner pins its fingerprint (from
  // the join token) before sending any fleet frame (see hub-dialer verifyPinnedCert).
  //
  // The /fleet listener is its OWN https server on its OWN port — the shared HTTP
  // server (/trpc + /health + /mcp + /api + REST-proxy) stays plain http, so the
  // renderer / CLI / e2e loopback assumptions are byte-identical. Upgrading the
  // muxed server to https would have risked all of those; isolating fleet onto a
  // second listener keeps the blast radius to fleet-mode-only.
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
  // The shared HTTP server carries ONLY `/trpc` (browser renderer, origin-guarded).
  // `/fleet` (non-browser runners) lives on a SEPARATE https listener stood up
  // below — so the shared server's WSS is the exact single-WSS construction whether
  // or not fleet mode is enabled → byte-identical behavior on the default path.
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/trpc',
    verifyClient: verifyTrpcClient
  })
  // Fleet mode: `/fleet` runs on its OWN https server (TLS-terminated with the hub
  // identity leaf) on its OWN port. Runners dial `wss://…/fleet` and pin the cert
  // fingerprint (carried in their join token) BEFORE any fleet frame is sent
  // (hub-dialer verifyPinnedCert). `noServer` — we demux `/fleet` ourselves so a
  // stray path can't reach the gateway. Both null when fleet mode is off (no https
  // server, no TLS termination) → shared http stack untouched.
  let fleetWss: WebSocketServer | null = null
  let fleetHttpsServer: HttpsServer | null = null
  if (fleetGateway && hubIdentity) {
    fleetWss = new WebSocketServer({ noServer: true })
    fleetHttpsServer = createHttpsServer({ key: hubIdentity.keyPem, cert: hubIdentity.certPem })
    fleetHttpsServer.on('upgrade', (req, socket, head) => {
      const pathname = (req.url ?? '').split('?')[0]
      if (pathname === '/fleet') {
        // No origin allowlist — runners are non-browser clients authenticated via
        // the fleet protocol (enroll/hello frames + join token), not Origin.
        fleetWss!.handleUpgrade(req, socket, head, (ws) => fleetGateway.handleConnection(ws))
      } else {
        socket.destroy()
      }
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
  // Fleet mode: bind the SEPARATE https `/fleet` listener on its own port (env
  // `SLAYZONE_FLEET_PORT`, else OS-assigned), then feed the resulting `wss://` URL
  // + cert fingerprint to the runners registry so `mintJoinToken` embeds them. The
  // fingerprint is the real hub leaf, and the listener now actually terminates TLS
  // with that leaf → the pin the runner extracts from its join token is enforced
  // end-to-end.
  //
  // Fleet is OPT-IN, so a fleet-port conflict must NOT abort startup: on a bind
  // failure `startFleetListener` closes the fleet listener + returns null, leaving
  // the shared http server (/trpc,/health,/mcp,REST) fully functional. Fleet just
  // stays dark (no listener info ⇒ `mintJoinToken` throws a clear error) until the
  // conflict is cleared + the sidecar restarts.
  if (fleetGateway && hubIdentity && fleetHttpsServer) {
    // Resolve a STABLE fleet port (Wave3.5-D5): explicit SLAYZONE_FLEET_PORT >
    // persisted settings.fleet_server_port > 0 (OS-assigned). Pinning the port
    // keeps the `wss://host:<port>/fleet` URL — and thus the runner's credential
    // key (hubHostFromUrl → host_port) — identical across reboots, so the local
    // runner `hello`s back into its existing row instead of re-enrolling a new one.
    const desiredFleetPort = await resolveDesiredFleetPort(db, process.env.SLAYZONE_FLEET_PORT)
    const bindFleet = (portEnv: string): Promise<Awaited<ReturnType<typeof startFleetListener>>> =>
      startFleetListener({
        server: fleetHttpsServer!,
        host,
        fingerprintSha256Hex: hubIdentity.fingerprintSha256Hex,
        fleetPortEnv: portEnv,
        log,
        onBindFailure: (error) => {
          recordDiagnosticEvent({
            level: 'error',
            source: 'server',
            event: 'fleet.listener_bind_failed',
            message: error.message
          })
        }
      })
    let info = await bindFleet(String(desiredFleetPort))
    // Robustness: a PINNED (non-zero) port that is stale-but-taken must NOT
    // darken fleet permanently. When a non-zero pin fails, retry with an
    // OS-assigned port (0) — same fallback the pre-pin default always had — and
    // re-persist below so the next boot pins the new one. An explicit operator
    // SLAYZONE_FLEET_PORT is intentionally NOT retried (respect the exact override
    // + surface the conflict). startFleetListener closes the server on failure;
    // the fleet-tls-listener test proves the same object rebinds cleanly after.
    let fellBackFromPinned = false
    if (!info && desiredFleetPort !== 0 && !process.env.SLAYZONE_FLEET_PORT) {
      log(`fleet listener could not bind pinned port ${desiredFleetPort} — retrying OS-assigned`)
      info = await bindFleet('0')
      fellBackFromPinned = info !== null
    }
    if (info) {
      composition.setFleetListenerInfo({
        hubUrl: info.hubUrl,
        certFingerprint: info.certFingerprint
      })
      // Persist the actually-bound port so the next boot reuses it (claim-once-
      // and-persist). Non-clobber guarded: won't overwrite a DIFFERENT port that
      // still has a live listener — EXCEPT when we just fell back from a failed
      // pinned bind, where the stored (conflicting) port is exactly what we must
      // overwrite. `force` skips the guard so the fleet URL stops churning every
      // boot. A same-value write (the steady-state reuse path) is a no-op.
      await claimFleetServerPort(db, host, info.port, log, { force: fellBackFromPinned })
      log(`fleet listener ready on ${info.hubUrl}`)
    } else {
      // Bind failed → drop our refs so stop() does not try to re-close the (already
      // closed) listener, and no `/fleet` upgrades are accepted.
      fleetHttpsServer = null
      fleetWss = null
    }
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
      // then close the fleet WSS + its https listener. No-op when fleet mode is off
      // (all null).
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
      if (fleetHttpsServer) {
        const srv = fleetHttpsServer
        try {
          await new Promise<void>((r) => srv.close(() => r()))
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
