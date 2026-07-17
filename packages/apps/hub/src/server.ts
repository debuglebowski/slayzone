import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import {
  appRouter,
  createMcpRestApp,
  parseAuthCallbackUrl,
  getAuthEvents,
  setHubDescribeDeps,
  setAuthGate
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
import { startRunnerListener } from './runner-listener.js'
import { startSidecarSocketServer, type SidecarSocketServer } from './sidecar-socket.js'
import { handleHealth, type HealthState } from './health.js'
import { getServerBuildInfo } from './build-info.js'
import { createLogger } from './log.js'
import { claimMcpServerPort, claimRunnerServerPort, resolveDesiredRunnerPort } from './port-claim.js'
import { parseWindowIdFromUrl, resolveConnectionPrincipal } from './hub-trpc-context.js'
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

  // --- Runner mode (hub/runner split, wave 2B) --------------------------------
  // `composition.runnersReady` resolves the async runner init (createHubAuth runs
  // better-auth migrations). It is an already-resolved no-op when runner mode is
  // off, so awaiting it is invisible on the default path — no listener, no
  // identity load, no mount happens below when the gateway/auth are null.
  await composition.runnersReady
  const runnerGateway = composition.runnerGateway
  const hubAuth = composition.hubAuth
  // better-auth express app for `/api/auth/*`. Mounted via a direct dispatch in
  // the HTTP request handler BELOW (not inside the mcpRest express app) so the
  // RAW request body reaches better-auth — mcpRest applies `express.json()`,
  // which would consume the body before better-auth sees it.
  const authApp = hubAuth ? createAuthExpressApp(hubAuth) : null
  // Hub TLS identity — loaded only under runner mode (creates <dataRoot>/identity/
  // on first run). Its `fingerprintSha256Hex` is fed to the runners registry so
  // `mintJoinToken` can pin it in a join token, AND its key/cert terminate TLS on
  // the SEPARATE https `/runners` listener stood up below. Cert-pinning is enforced
  // end-to-end: the hub presents this leaf, the runner pins its fingerprint (from
  // the join token) before sending any runner frame (see hub-dialer verifyPinnedCert).
  //
  // The /runners listener is its OWN https server on its OWN port — the shared HTTP
  // server (/trpc + /health + /mcp + /api + REST-proxy) stays plain http, so the
  // renderer / CLI / e2e loopback assumptions are byte-identical. Upgrading the
  // muxed server to https would have risked all of those; isolating runner onto a
  // second listener keeps the blast radius to runner-mode-only.
  const hubIdentity = runnerGateway ? await loadOrCreateHubIdentity(dataRoot) : null
  if (runnerGateway) log('runner mode enabled (gateway + hub-auth + identity loaded)')

  // Multi-hub: wire the client-facing `hub.describe` identity deps so a
  // connecting client learns this hub's cert fingerprint + whether it enforces
  // auth. Both degrade safely (null / false) on a plain local hub — describe
  // already tolerated the deps being unset, this just fills them when known.
  const hubAuthRequired = process.env.SLAYZONE_HUB_AUTH_REQUIRED === '1' && hubAuth != null
  setHubDescribeDeps({
    getFingerprint: () => hubIdentity?.fingerprintSha256Hex ?? null,
    getAuthRequired: () => hubAuthRequired
  })
  // Gate all (non-open) tRPC procedures on a verified principal when this hub
  // enforces auth. Off → inert pass-through (byte-identical).
  setAuthGate(() => hubAuthRequired)

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
  // supervised) + `/api/auth/*` → hub-auth (runner mode only, RAW body) + /api/*
  // + /mcp via express + /trpc WS upgrade.
  const httpServer = createServer((req, res) => {
    if (handleHealth(state, req, res)) return
    if (hostRestUrl && needsHostRest(req.url)) {
      proxyToHostRest(hostRestUrl, req, res)
      return
    }
    // Runner mode: `/api/auth/*` goes to the hub-auth express app BEFORE the
    // mcpRest stack, which applies `express.json()` — better-auth needs the raw
    // body. Absent when runner mode is off, so the default path is unchanged.
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
  // `/runners` (non-browser runners) lives on a SEPARATE https listener stood up
  // below — so the shared server's WSS is the exact single-WSS construction whether
  // or not runner mode is enabled → byte-identical behavior on the default path.
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/trpc',
    verifyClient: verifyTrpcClient
  })
  // Multi-hub auth: a remote hub that enforces auth ALSO terminates TLS on
  // `/trpc` so clients can dial `wss://…/trpc` and pin the cert (renderer pins in
  // the Electron main process via setCertificateVerifyProc). This is a SEPARATE
  // https listener on its own port (SLAYZONE_HUB_TLS_PORT, else OS-assigned),
  // reusing the hub identity leaf — the plain-http `/trpc` above is untouched, so
  // local loopback + e2e stay byte-identical. Off unless auth is required + an
  // identity is loaded.
  const hubTlsEnabled = hubAuthRequired && hubIdentity != null
  let tlsWss: WebSocketServer | null = null
  let tlsHttpsServer: HttpsServer | null = null
  if (hubTlsEnabled && hubIdentity) {
    tlsHttpsServer = createHttpsServer(
      { key: hubIdentity.keyPem, cert: hubIdentity.certPem },
      (req, res) => {
        // Mirror the muxed plain server so wss clients get /health etc. too.
        if (handleHealth(state, req, res)) return
        if (authApp && (req.url ?? '').split('?')[0].startsWith('/api/auth/')) {
          authApp(req, res)
          return
        }
        mcpRest.app(req, res)
      }
    )
    tlsWss = new WebSocketServer({
      server: tlsHttpsServer,
      path: '/trpc',
      verifyClient: verifyTrpcClient
    })
  }
  // Runner mode: `/runners` runs on its OWN https server (TLS-terminated with the hub
  // identity leaf) on its OWN port. Runners dial `wss://…/runners` and pin the cert
  // fingerprint (carried in their join token) BEFORE any runner frame is sent
  // (hub-dialer verifyPinnedCert). `noServer` — we demux `/runners` ourselves so a
  // stray path can't reach the gateway. Both null when runner mode is off (no https
  // server, no TLS termination) → shared http stack untouched.
  let runnerWss: WebSocketServer | null = null
  let runnerHttpsServer: HttpsServer | null = null
  if (runnerGateway && hubIdentity) {
    runnerWss = new WebSocketServer({ noServer: true })
    runnerHttpsServer = createHttpsServer({ key: hubIdentity.keyPem, cert: hubIdentity.certPem })
    runnerHttpsServer.on('upgrade', (req, socket, head) => {
      const pathname = (req.url ?? '').split('?')[0]
      if (pathname === '/runners') {
        // No origin allowlist — runners are non-browser clients authenticated via
        // the runner protocol (enroll/hello frames + join token), not Origin.
        runnerWss!.handleUpgrade(req, socket, head, (ws) => runnerGateway.handleConnection(ws))
      } else {
        socket.destroy()
      }
    })
  }
  // createContext verifies the bearer only when this hub enforces auth
  // (`hubAuthRequired`, defined above). Local loopback hubs leave it off →
  // principal stays null, no verify → byte-identical to trusted loopback.
  const createTrpcContext = async ({
    req,
    info
  }: {
    req: IncomingMessage
    info?: { connectionParams?: Record<string, string | undefined> | null }
  }) => {
    // windowId (?windowId=N) → ctx.windowId. Required by claimSession +
    // panel-ownership + warm-pool (warmSetProjectTabCounts) procs; without it they
    // throw "windowId required". This sidecar's applyWSSHandler had omitted it (the
    // transport ws-server parses it, but the sidecar uses THIS handler) — so the
    // whole warm-agent pool silently never fired. The renderer already sends it
    // (see main.tsx withWindowId).
    const windowId = parseWindowIdFromUrl(req.url)
    // Verify the bearer token from tRPC connectionParams when this hub enforces
    // auth. An invalid/absent token → principal stays null; individual procedures
    // gate on ctx.principal via the auth gate (an authed hub still accepts the
    // connection but attributes it). See hub-trpc-context.ts for the decision.
    const principal = await resolveConnectionPrincipal({
      hubAuthRequired,
      hubAuth,
      token: info?.connectionParams?.token
    })
    return {
      db,
      dataRoot,
      req,
      automationEngine: composition.automationEngine,
      windowId,
      principal
    }
  }
  const wssHandler = applyWSSHandler({ wss, router: appRouter, createContext: createTrpcContext })
  // Same handler on the TLS /trpc listener (wss) when a remote hub terminates TLS.
  const tlsWssHandler = tlsWss
    ? applyWSSHandler({ wss: tlsWss, router: appRouter, createContext: createTrpcContext })
    : null

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

  // Multi-hub TLS `/trpc`: bind the https listener on its own port
  // (SLAYZONE_HUB_TLS_PORT, else OS-assigned). OPT-IN — a bind failure must NOT
  // abort startup (the plain http /trpc still serves loopback + e2e), so we log +
  // leave TLS dark. Report the wss URL for operators/UX.
  let hubTlsPort: number | null = null
  if (tlsHttpsServer) {
    const desiredTlsPort = Number(process.env.SLAYZONE_HUB_TLS_PORT ?? '0') || 0
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: unknown): void => {
          tlsHttpsServer!.off('error', onError)
          reject(err)
        }
        tlsHttpsServer!.once('error', onError)
        tlsHttpsServer!.listen(desiredTlsPort, host, () => {
          tlsHttpsServer!.off('error', onError)
          resolve()
        })
      })
      const tlsAddr = tlsHttpsServer.address()
      hubTlsPort = typeof tlsAddr === 'object' && tlsAddr ? tlsAddr.port : desiredTlsPort
      log(`hub TLS /trpc listening: wss://${host}:${hubTlsPort}/trpc`)
    } catch (err) {
      log(`hub TLS /trpc bind failed (staying plain http): ${String(err)}`)
      try {
        tlsWssHandler?.broadcastReconnectNotification?.()
      } catch {
        /* ignore */
      }
      tlsHttpsServer = null
    }
  }
  // Runner mode: bind the SEPARATE https `/runners` listener on its own port (env
  // `SLAYZONE_RUNNER_TRANSPORT_PORT`, else OS-assigned), then feed the resulting `wss://` URL
  // + cert fingerprint to the runners registry so `mintJoinToken` embeds them. The
  // fingerprint is the real hub leaf, and the listener now actually terminates TLS
  // with that leaf → the pin the runner extracts from its join token is enforced
  // end-to-end.
  //
  // Runner is OPT-IN, so a runner-port conflict must NOT abort startup: on a bind
  // failure `startRunnerListener` closes the runner listener + returns null, leaving
  // the shared http server (/trpc,/health,/mcp,REST) fully functional. Runner just
  // stays dark (no listener info ⇒ `mintJoinToken` throws a clear error) until the
  // conflict is cleared + the sidecar restarts.
  if (runnerGateway && hubIdentity && runnerHttpsServer) {
    // Resolve a STABLE runner port (Wave3.5-D5): explicit SLAYZONE_RUNNER_TRANSPORT_PORT >
    // persisted settings.runner_transport_port > 0 (OS-assigned). Pinning the port
    // keeps the `wss://host:<port>/runners` URL — and thus the runner's credential
    // key (hubHostFromUrl → host_port) — identical across reboots, so the local
    // runner `hello`s back into its existing row instead of re-enrolling a new one.
    const desiredRunnerPort = await resolveDesiredRunnerPort(db, process.env.SLAYZONE_RUNNER_TRANSPORT_PORT)
    const bindRunnerListener = (portEnv: string): Promise<Awaited<ReturnType<typeof startRunnerListener>>> =>
      startRunnerListener({
        server: runnerHttpsServer!,
        host,
        fingerprintSha256Hex: hubIdentity.fingerprintSha256Hex,
        runnerPortEnv: portEnv,
        log,
        onBindFailure: (error) => {
          recordDiagnosticEvent({
            level: 'error',
            source: 'server',
            event: 'runner.listener_bind_failed',
            message: error.message
          })
        }
      })
    let info = await bindRunnerListener(String(desiredRunnerPort))
    // Robustness: a PINNED (non-zero) port that is stale-but-taken must NOT
    // darken runner permanently. When a non-zero pin fails, retry with an
    // OS-assigned port (0) — same fallback the pre-pin default always had — and
    // re-persist below so the next boot pins the new one. An explicit operator
    // SLAYZONE_RUNNER_TRANSPORT_PORT is intentionally NOT retried (respect the exact override
    // + surface the conflict). startRunnerListener closes the server on failure;
    // the runner-tls-listener test proves the same object rebinds cleanly after.
    let fellBackFromPinned = false
    if (!info && desiredRunnerPort !== 0 && !process.env.SLAYZONE_RUNNER_TRANSPORT_PORT) {
      log(`runner listener could not bind pinned port ${desiredRunnerPort} — retrying OS-assigned`)
      info = await bindRunnerListener('0')
      fellBackFromPinned = info !== null
    }
    if (info) {
      composition.setRunnerListenerInfo({
        hubUrl: info.hubUrl,
        certFingerprint: info.certFingerprint
      })
      // Persist the actually-bound port so the next boot reuses it (claim-once-
      // and-persist). Non-clobber guarded: won't overwrite a DIFFERENT port that
      // still has a live listener — EXCEPT when we just fell back from a failed
      // pinned bind, where the stored (conflicting) port is exactly what we must
      // overwrite. `force` skips the guard so the runner URL stops churning every
      // boot. A same-value write (the steady-state reuse path) is a no-op.
      await claimRunnerServerPort(db, host, info.port, log, { force: fellBackFromPinned })
      log(`runner listener ready on ${info.hubUrl}`)
    } else {
      // Bind failed → drop our refs so stop() does not try to re-close the (already
      // closed) listener, and no `/runners` upgrades are accepted.
      runnerHttpsServer = null
      runnerWss = null
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
      // Runner mode: terminate every runner connection + reject in-flight requests,
      // then close the runner WSS + its https listener. No-op when runner mode is off
      // (all null).
      if (runnerGateway) {
        try {
          runnerGateway.close()
        } catch {
          /* ignore */
        }
      }
      if (runnerWss) {
        try {
          runnerWss.close()
        } catch {
          /* ignore */
        }
      }
      if (runnerHttpsServer) {
        const srv = runnerHttpsServer
        try {
          await new Promise<void>((r) => srv.close(() => r()))
        } catch {
          /* ignore */
        }
      }
      // Multi-hub TLS /trpc: close the wss + its https listener (no-op when off).
      if (tlsWss) {
        try {
          tlsWss.close()
        } catch {
          /* ignore */
        }
      }
      if (tlsHttpsServer) {
        const srv = tlsHttpsServer
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
