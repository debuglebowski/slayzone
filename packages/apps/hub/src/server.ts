import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
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
import {
  ensureDataRoot,
  getServerHost,
  getTrpcPort,
  getSlayzoneMode,
  isRemoteMode,
  assertModeHostConsistency
} from '@slayzone/platform'
import {
  getDatabasePathFromEnv,
  openServerDatabase,
  openServerDiagnosticsDatabase
} from './db.js'
import { composeServer } from './composition.js'
import { getBridgeRestUrl } from './bridge-url.js'
import { deriveRunnerHubUrl } from './runner-listener.js'
import { startSidecarSocketServer, type SidecarSocketServer } from './sidecar-socket.js'
import { handleHealth, type HealthState } from './health.js'
import { getServerBuildInfo } from './build-info.js'
import { createLogger } from './log.js'
import { claimServerPort } from './port-claim.js'
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
  // SLAYZONE_MODE hardening. Supervised is always local/loopback (the Electron
  // host owns it), so the mode/bind guard applies to standalone only: refuse to
  // boot an exposed-but-unhardened hub (mode=local + non-loopback bind).
  if (!supervised) {
    assertModeHostConsistency(getSlayzoneMode(), host)
    // Remote runners reach this hub's MCP/hook callbacks via SLAYZONE_HUB_PUBLIC_URL;
    // it can't be auto-derived (the hub can't know its own external address). In
    // remote mode a missing/blank value would silently degrade every remote agent
    // to an unreachable loopback target — fail loud at boot instead.
    if (isRemoteMode() && !process.env.SLAYZONE_HUB_PUBLIC_URL?.trim()) {
      throw new Error(
        '[slayzone] SLAYZONE_MODE=remote requires SLAYZONE_HUB_PUBLIC_URL ' +
          '(the externally-reachable hub base URL for remote runners) — set it or use SLAYZONE_MODE=local.'
      )
    }
  }
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

  // --- Runner transport ---
  // `composition.runnersReady` resolves the async runner init (createHubAuth runs
  // better-auth migrations, then the gateway builds). A hub always accepts
  // runners, so this always runs; the null-guards below are init-FAILURE
  // degradation (createHubAuth threw) — not a mode — so a broken auth DB can't
  // crash the whole hub, it just leaves runner enroll unavailable.
  await composition.runnersReady
  const runnerGateway = composition.runnerGateway
  const hubAuth = composition.hubAuth
  // better-auth express app for `/api/auth/*`. Mounted via a direct dispatch in
  // the HTTP request handler BELOW (not inside the mcpRest express app) so the
  // RAW request body reaches better-auth — mcpRest applies `express.json()`,
  // which would consume the body before better-auth sees it.
  const authApp = hubAuth ? createAuthExpressApp(hubAuth) : null
  // Hub TLS identity (creates <dataRoot>/identity/ on first run). Its
  // `fingerprintSha256Hex` is fed to the runners registry so `mintJoinToken` can
  // pin it in a join token, AND its key/cert terminate TLS on the SEPARATE https
  // `/runners` listener stood up below. Cert-pinning is enforced end-to-end: the
  // hub presents this leaf, the runner pins its fingerprint (from the join token)
  // before sending any runner frame (see hub-dialer verifyPinnedCert). Loaded
  // whenever the gateway came up (i.e. always, barring an init failure).
  //
  // The /runners listener is its OWN https server on its OWN port — the shared HTTP
  // server (/trpc + /health + /mcp + /api + REST-proxy) stays plain http, so the
  // renderer / CLI / e2e loopback assumptions are unchanged; isolating the runner
  // link onto a second listener keeps the shared server plain.
  const hubIdentity = runnerGateway ? await loadOrCreateHubIdentity(dataRoot) : null
  if (runnerGateway) log('runner transport ready (gateway + hub-auth + identity loaded)')

  // Multi-hub: wire the client-facing `hub.describe` identity deps so a
  // connecting client learns this hub's cert fingerprint + whether it enforces
  // auth. Auth-required is now DERIVED from SLAYZONE_MODE (remote ⇒ on) rather
  // than a separate flag — an internet-facing hub gates client /trpc; a loopback
  // (local/supervised) hub does not. Still requires hubAuth to have loaded.
  const hubAuthRequired = isRemoteMode() && hubAuth != null
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
  // Derived from the single host bridge URL (same listener serves cap WS + REST).
  const hostRestUrl = getBridgeRestUrl()

  // SLAYZONE_MODE is the SINGLE lever for the whole hub's transport: `local`
  // (default) serves plain http/ws on loopback (dev, e2e, supervised); `remote`
  // serves https/wss terminated with the hub identity leaf. There is no separate
  // TLS port and no separate runner port — `/trpc` (clients) and `/runners`
  // (runners) ride the ONE listener below, demuxed by path. Protocol is never a
  // knob; it is implied by mode. Both axes present the same identity leaf in
  // remote, so a runner's pinned fingerprint is unchanged from the old split.
  const remote = isRemoteMode()
  // Remote REQUIRES the hub identity leaf to terminate TLS. Fail loud rather than
  // serve an unhardened (plaintext, unauthenticated) internet-facing hub. The
  // identity is loaded whenever the runner gateway came up (i.e. always, barring
  // an init failure); a remote hub whose gateway failed to init has no leaf and
  // must not boot.
  if (remote && !hubIdentity) {
    throw new Error(
      '[slayzone] SLAYZONE_MODE=remote but the hub identity could not be loaded ' +
        '(runner gateway init failed) — refusing to boot an unhardened remote hub.'
    )
  }

  // Single muxed server: /health (pre-express, stays alive even if the express
  // stack wedges) + Electron-only REST reverse-proxied to the host (when
  // supervised) + `/api/auth/*` → hub-auth (RAW body) + /api/* + /mcp via express.
  // `/trpc` + `/runners` WS upgrades are demuxed in the `upgrade` handler below.
  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (handleHealth(state, req, res)) return
    if (hostRestUrl && needsHostRest(req.url)) {
      proxyToHostRest(hostRestUrl, req, res)
      return
    }
    // Runner transport: `/api/auth/*` goes to the hub-auth express app BEFORE the
    // mcpRest stack, which applies `express.json()` — better-auth needs the raw
    // body. Present whenever hub-auth built (always, barring init failure).
    if (authApp && (req.url ?? '').split('?')[0].startsWith('/api/auth/')) {
      authApp(req, res)
      return
    }
    mcpRest.app(req, res)
  }
  const httpServer =
    remote && hubIdentity
      ? createHttpsServer({ key: hubIdentity.keyPem, cert: hubIdentity.certPem }, handleRequest)
      : createServer(handleRequest)

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
  // Both WS endpoints ride the ONE `httpServer` (plain or TLS per mode) as
  // `noServer` handlers, demuxed by path in the single `upgrade` listener below.
  // A `server`-bound WSS would destroy any socket whose path it doesn't own, so
  // two endpoints on one server MUST both be `noServer` + hand-demuxed. `noServer`
  // also means `verifyClient` is never invoked — the `/trpc` origin guard is
  // applied inline in the demux instead (see below).
  //
  //   /trpc    — clients (renderer / federated hubs), origin-guarded. In remote
  //              mode the leaf terminates TLS so clients dial `wss://…/trpc` and
  //              pin the cert (renderer pins in main via setCertificateVerifyProc).
  //   /runners — runners (non-browser), NO origin allowlist (authenticated by the
  //              runner protocol: enroll/hello frames + join token). In remote mode
  //              the SAME leaf terminates TLS, so the runner's pinned fingerprint
  //              (carried in its join token) is enforced end-to-end, unchanged from
  //              the old separate-listener design.
  const wss = new WebSocketServer({ noServer: true })
  const runnerWss = runnerGateway && hubIdentity ? new WebSocketServer({ noServer: true }) : null
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0]
    if (pathname === '/trpc') {
      // Origin guard (was verifyClient; noServer skips it). A drive-by web page or
      // DNS-rebind must not reach the full app router — native/loopback origins only.
      const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
      if (!isAllowedWsOrigin(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } else if (pathname === '/runners' && runnerWss && runnerGateway) {
      runnerWss.handleUpgrade(req, socket, head, (ws) => runnerGateway.handleConnection(ws))
    } else {
      // No handler owns this path — reject rather than leave the socket dangling.
      socket.destroy()
    }
  })
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

  // Runner `/runners` rides the SAME listener as `/trpc` (bound above) — no
  // separate port to claim, no separate bind to fail. Feed the runners registry
  // the advertised `ws(s)://…/runners` URL + cert fingerprint so `mintJoinToken`
  // embeds them. Scheme follows mode: local → `ws://` loopback (dev/supervised);
  // remote → `wss://` derived from SLAYZONE_HUB_PUBLIC_URL (the hub's single
  // external address, which now serves BOTH axes). The fingerprint is the real hub
  // leaf — in remote the one listener terminates TLS with it, so the runner's
  // join-token pin is enforced end-to-end, exactly as under the old split listener.
  //
  // The runner URL's port is the hub port (stable via claimServerPort /
  // SIDECAR_FIXED_PORT), so the runner credential key (hubHostFromUrl → host_port)
  // stays stable across reboots WITHOUT a dedicated runner-port persistence layer —
  // that layer existed ONLY to pin a separate OS-assigned port, now gone.
  if (runnerGateway && hubIdentity) {
    const runnerHubUrl = deriveRunnerHubUrl({
      remote,
      host,
      port: actualPort,
      publicUrl: process.env.SLAYZONE_HUB_PUBLIC_URL
    })
    if (runnerHubUrl) {
      composition.setRunnerListenerInfo({
        hubUrl: runnerHubUrl,
        certFingerprint: hubIdentity.fingerprintSha256Hex
      })
      log(`runner transport ready on ${runnerHubUrl}`)
    } else {
      // Only reachable if SLAYZONE_HUB_PUBLIC_URL is malformed in remote mode
      // (an unset value already fails loud at boot). `mintJoinToken` then throws a
      // clear "hub url unset" until fixed — the /trpc path is unaffected.
      recordDiagnosticEvent({
        level: 'error',
        source: 'server',
        event: 'runner.hub_url_underivable',
        message: 'runner transport URL could not be derived (check SLAYZONE_HUB_PUBLIC_URL)'
      })
      log('runner transport URL could not be derived — runner enroll unavailable')
    }
  }
  // Agents spawned BY this process discover their hook endpoint via this global.
  ;(globalThis as Record<string, unknown>).__serverPort = actualPort
  // Slice 9 live cutover: the side-car is now the discoverable backend — the CLI,
  // agents, and external MCP resolve `settings.server_port` to reach HERE
  // (the host's REST runs with writePort:false). Single writer of this key —
  // guarded against clobbering a still-live sidecar (plans/sidecar-staleness.md
  // Phase 4, see port-claim.ts).
  await claimServerPort(db, host, actualPort, log)
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
      // Terminate every runner connection + reject in-flight requests,
      // then close the runner WSS + its https listener. No-op if the runner init failed
      // (all null).
      if (runnerGateway) {
        try {
          runnerGateway.close()
        } catch {
          /* ignore */
        }
      }
      // `/runners` shares the one httpServer as a noServer WSS — close it to drop
      // the gateway sockets; there is no separate runner/TLS listener to close.
      if (runnerWss) {
        try {
          runnerWss.close()
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
