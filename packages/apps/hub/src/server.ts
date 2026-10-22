import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
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
import { beginTerminalShutdown } from '@slayzone/terminal/server'
import { createAuthExpressApp, loadEntraClientCredential } from '@slayzone/hub-auth/server'
import {
  bindInHubPortBlock,
  ensureDataRoot,
  getServerHost,
  getSlayzoneHomeDir,
  getTrpcPort
} from '@slayzone/platform'
import { resolveHubName } from '@slayzone/platform/slayzone-config'
import { getDatabasePathFromEnv, openServerDatabase, openServerDiagnosticsDatabase } from './db.js'
import { assertAuthLoaded, assertHubBootRules, assertSsoCredential } from './boot-rules.js'
import { composeServer } from './composition.js'
import { deriveComputerHubUrl } from './computer-listener.js'
import { startSidecarSocketServer, type SidecarSocketServer } from './sidecar-socket.js'
import { handleHealth, type HealthState } from './health.js'
import { handleWebAssets } from './web-assets.js'
import { getServerBuildInfo } from './build-info.js'
import { ensureBootstrapOwner } from './bootstrap-owner'
import { backfillOwnership } from './ownership-backfill.js'
import { createLogger } from './log.js'
import { claimServerPort } from './port-claim.js'
import { parseWindowIdFromUrl, resolveConnectionPrincipal } from './hub-trpc-context.js'
import { withRestAuth } from './rest-auth.js'
import { handleDevSql, isDevSqlEnabled } from './dev-sql.js'
import { wsOriginDecision, resolveAllowedWebOrigins } from './ws-origin.js'
import { recordDiagnosticEvent, flushWriteQueue } from '@slayzone/diagnostics/server'
import { peerAddress, routeOf, securityEvent } from '@slayzone/platform/security-log'
import type { ServerHandle, StartServerConfig } from './index.js'

/**
 * The web shell's build output (`@slayzone/web-shell`'s `vite.config.ts` sets
 * `build.outDir` to exactly this path). Computed as an OFFSET from this
 * file's own location — via `__dirname`, NOT `import.meta.url` (esbuild
 * cannot rewrite that for a CJS bundle; it warns and silently empties it,
 * see build.mjs's `format: 'cjs'`) — so it resolves correctly whether this
 * module runs as raw TS source (`packages/apps/hub/src/server.ts` — dev,
 * tests) or bundled (`packages/apps/hub/dist/bin.cjs` — production): both
 * are exactly one level below the hub package root, `join(<that dir>, '..',
 * 'dist', 'web')` lands on `<package root>/dist/web` either way.
 */
const WEB_ROOT = join(__dirname, '..', 'dist', 'web')

export async function startServer(cfg: StartServerConfig = {}): Promise<ServerHandle> {
  const host = cfg.host ?? getServerHost()
  const supervised = process.env.SLAYZONE_SUPERVISED === '1'

  // Every rule that refuses to start the hub runs HERE, before it creates its data
  // directory, opens its database or binds a port — see boot-rules.ts for the
  // rules (B1–B14) and the reasoning behind each. A refusal throws a message that
  // names the variable to change.
  //
  // `SLAYZONE_SUPERVISED` keeps only the meaning "started by the desktop app" (hub
  // name, restore allowed, no prompts, no config file, listens on loopback). It no
  // longer decides anything about login: that is `SLAYZONE_HUB_REQUIRE_LOGIN`, which
  // the desktop app sets to 0 for its own hub.
  const boot = assertHubBootRules({
    env: process.env,
    host,
    supervised,
    devSqlEnabled: isDevSqlEnabled()
  })
  const { switches } = boot
  // B7, second half: Entra sign-in's certificate and key load — still before the hub
  // has created anything. Null unless SSO is on (login required + ENABLE_SSO=1).
  const sso = assertSsoCredential(boot, loadEntraClientCredential)

  const dataRoot = cfg.storeDir ?? ensureDataRoot()
  const log = createLogger(dataRoot)

  const dbPath = getDatabasePathFromEnv()
  // The hub owns the schema however it was started. `supervised` still gates the
  // sidecar socket and the loopback-bind rule above — but not this: a second
  // migrator in the Electron host is exactly the two-writers-one-file split being
  // removed.
  // Migrations are user_version-gated and individually atomic, so this is a no-op
  // against an already-current store.
  const db = cfg.db ?? (await openServerDatabase())
  const ownsDb = cfg.db === undefined
  log(`db opened: ${dbPath} (schema bootstrapped)`)

  // Separate diagnostics events DB so THIS process's recordDiagnosticEvent calls
  // (pty + agent pool run here) persist + are queryable, instead of buffering +
  // dropping. Always owned here (independent of cfg.db).
  const diagnosticsDb = openServerDiagnosticsDatabase()

  // Populate every transport registry BEFORE accepting connections, so the
  // first procedure call can't hit an uninitialized dep.
  const composition = composeServer({
    db,
    dataRoot,
    standalone: !supervised,
    requireLogin: switches.requireLogin,
    publicAddress: boot.publicAddress,
    sso,
    diagnosticsDb
  })
  const mcpRest = createMcpRestApp(composition.restDeps)
  log('composition wired (tRPC registries + MCP/REST app)')

  // --- Computer transport ---
  // `composition.computersReady` resolves the async computer init (createHubAuth runs
  // better-auth migrations, then the gateway builds). A hub always accepts
  // computers, so this always runs; the null-guards below are init-FAILURE
  // degradation (createHubAuth threw) — not a mode — so a broken auth DB can't
  // crash the whole hub, it just leaves computer enroll unavailable.
  await composition.computersReady
  const computerGateway = composition.computerGateway
  const hubAuth = composition.hubAuth
  // better-auth express app for `/api/auth/*`. Mounted via a direct dispatch in
  // the HTTP request handler BELOW (not inside the mcpRest express app) so the
  // RAW request body reaches better-auth — mcpRest applies `express.json()`,
  // which would consume the body before better-auth sees it.
  const authApp = hubAuth ? createAuthExpressApp(hubAuth) : null
  if (computerGateway) log('computer transport ready (gateway + hub-auth loaded)')

  // Multi-hub: wire the client-facing `hub.describe` deps so a connecting client
  // learns whether this hub enforces auth and which switches it runs with.
  //
  // Whether clients must sign in is the `SLAYZONE_HUB_REQUIRE_LOGIN` switch — the
  // ONE thing that decides it. It is not derived from how the hub was started
  // (`supervised`), from whether it is loopback, or from any mode. (Boot rule B1
  // is what keeps a login-less hub from being reachable off-box.) Ownership of a
  // computer is meaningless without a user identity, so a hub other machines can
  // reach always requires one.
  const hubAuthRequired = switches.requireLogin
  // Fail CLOSED (B11). A hub whose auth failed to initialize must not fall back to
  // serving every client unauthenticated. Computers already fail closed here (a
  // broken auth DB makes enroll unavailable rather than unauthenticated); clients
  // do too.
  assertAuthLoaded(hubAuthRequired, hubAuth)
  setHubDescribeDeps({
    getAuthRequired: () => hubAuthRequired,
    getSwitches: () => switches
  })
  // Gate all (non-open) tRPC procedures on a verified principal when this hub
  // enforces auth. Off → inert pass-through (byte-identical).
  setAuthGate(() => hubAuthRequired)

  // A hub that requires login must not come up unusable by the operator who just
  // started it. Creates the first user on first boot only, prints the credentials
  // once, and leaves them in a 0600 file `slay` reads on this box. (A generated
  // password is a password sign-in; skipping this when `ENABLE_PASSWORD=0` belongs
  // to the work that enforces that switch.)
  //
  // Not on a hub with Entra sign-in: its accounts come from Entra and admin only from
  // the `SlayZone.Admin` app role (O-4), so an owner minted here would be exactly the
  // admin that rule excludes. Users sign in through Entra; the first admin is whoever
  // first signs in holding the app role.
  if (hubAuthRequired && hubAuth && !boot.ssoActive) {
    try {
      await ensureBootstrapOwner(hubAuth, dataRoot, (m) => log(m))
    } catch (err) {
      // A hub with no owner is still a correctly-secured hub — the operator can
      // add one with `slay hub users add`. Do not fail the boot over convenience.
      log(
        `[slayzone] could not provision a bootstrap owner: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // T-16: unowned projects (an upgrade, or created while login was off) and the
  // pre-login settings rows go to the first admin — after the accounts above are
  // settled, before the hub listens. No-op without login, and once done.
  try {
    await backfillOwnership({ db, hubAuth, requireLogin: hubAuthRequired, log })
  } catch (err) {
    // Unowned projects are refused to every user, never shown to all, so a failed
    // pass loses nothing; the next boot retries.
    log(
      `[ownership] backfill failed, retried next boot: ${err instanceof Error ? err.message : String(err)}`
    )
  }

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

  // /health doubles as the multi-hub discovery channel: `slay hub ls` probes the
  // hub port block and builds its table from these fields, so a hub is only
  // findable/addressable if it reports them. Identity fields are served to
  // loopback callers only (see handleHealth). `computersConnected` is a getter so it
  // tracks the live gateway rather than freezing at boot.
  const state: HealthState = {
    ready: false,
    port: 0,
    startedAt: Date.now(),
    dbPath,
    name: resolveHubName(),
    root: getSlayzoneHomeDir(),
    pid: process.pid,
    supervised,
    // Same bit `hub.describe` reports over /trpc — mirrored on /health so a
    // client can learn "this hub needs a sign-in" without opening a socket. This
    // is where `slay` reads it; `supervised` says nothing about login.
    authRequired: hubAuthRequired,
    // Every switch, for the same reason (and for `slay hub ls`).
    switches,
    // B13 — gates the host-describing fields behind "no proxy in the path".
    reachable: boot.reachable,
    // `listUsableComputers`, NOT `listComputers` — its own docstring names itself the
    // single authority for "can this computer do work right now?" and warns that the
    // raw map means only "socket is open", including a computer that has stopped
    // responding but not yet been reaped. `/health.computersConnected` is read as a
    // READINESS gate (an e2e worker waits on it before dispatching), so the raw
    // count reports `connected: true` for a computer that cannot take work — the
    // symptom recorded in e2e/global-setup.ts: a fresh worker's gate satisfied in
    // ~14ms by a computer that process never spawned, which then dies mid-test.
    computersConnected: () => computerGateway?.listUsableComputers().length ?? 0
  }

  // The hub always listens plain http/ws. It never terminates TLS: a hub that other
  // machines reach sits behind a front end that does (Azure's, Caddy, nginx), and
  // clients dial that front end's public address with https/wss (rule A1). `/trpc`
  // (clients) and `/computers` (computers) ride the ONE listener below, demuxed by
  // path.

  // Single muxed server: /health (pre-express, stays alive even if the express
  // stack wedges) + Electron-only REST reverse-proxied to the desktop app (when
  // supervised) + `/api/auth/*` → hub-auth (RAW body) + /api/* + /mcp via express.
  // `/trpc` + `/computers` WS upgrades are demuxed in the `upgrade` handler below.
  //
  // Everything past /health rides the same bearer gate as `/trpc` (see
  // rest-auth.ts). Inert when the hub doesn't enforce auth: `restAuthAction`
  // short-circuits to 'allow' with no verify call. `/api/browser/*` now runs in
  // THIS process (it drives arbitrary JS eval in a real browser view, so it is the
  // last thing that should be reachable unauthenticated) rather than being piped
  // onward to an unauthenticated loopback listener on the desktop.
  const dispatchRequest = (req: IncomingMessage, res: ServerResponse): void => {
    // E2E-only raw SQL. Off unless PLAYWRIGHT=1.
    //
    // This is `withRestAuth`'s `next`, so it runs BELOW the bearer gate — the old
    // comment here claimed the opposite. The distinction matters: on a supervised
    // hub the gate is off and the harness reaches this with no bearer (the case
    // that comment was describing), while on a standalone hub `/api/dev/*` is an
    // ordinary `/api/` path and must present one like anything else. Three
    // independent conditions therefore have to hold before a byte of SQL runs:
    // PLAYWRIGHT=1, a loopback bind (asserted at boot), and a loopback peer
    // (checked inside `handleDevSql`) — plus the gate whenever it is on.
    if (handleDevSql(db, req, res)) return
    // Computer transport: `/api/auth/*` goes to the hub-auth express app BEFORE the
    // mcpRest stack, which applies `express.json()` — better-auth needs the raw
    // body. Present whenever hub-auth built (always, barring init failure).
    //
    // EXCEPT `/api/auth/web-login`: that route is OURS (`registerWebLoginRoute`),
    // mounted on `mcpRest.app`, not better-auth's `authApp` — better-auth has no
    // route by that name, so routing it here would 404 it against authApp and
    // never let mcpRest.app's own registration see the request at all. This
    // was exactly that bug: the entire scoped web-session login path was
    // unreachable in a real running hub until this carve-out existed.
    const authPath = (req.url ?? '').split('?')[0]
    if (authApp && authPath.startsWith('/api/auth/') && authPath !== '/api/auth/web-login') {
      // The apiKey plugin's CLIENT routes are never served. `mintComputerApiKey`
      // calls `auth.api.createApiKey` in-process (the server branch), so nothing
      // in SlayZone needs them over HTTP — while `POST /api/auth/api-key/create`
      // accepts a session plus arbitrary metadata, which is how an ordinary
      // account holder could mint a credential naming someone else's computer.
      // `verifyComputerApiKey`'s `referenceId` check already refuses such a key;
      // this closes the door rather than relying solely on the far end noticing.
      if (authPath.startsWith('/api/auth/api-key/')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
        return
      }
      authApp(req, res)
      return
    }
    // The web shell's static bundle + SPA fallback. Reachable regardless of
    // `hubAuthRequired` — `restAuthAction` (rest-auth.ts) already resolves
    // every non-`/api`/`/mcp` path to 'allow' unconditionally, and the shell
    // IS the login screen, so it must load with no credential at all. Absent
    // `dist/web/` (dev, or a build that skipped it) returns false untouched,
    // falling through to mcpRest's own 404 exactly as before this shipped.
    //
    // Served on every hub. It used to be gated on `remote || supervised` so a
    // browser session's scoped token — a real bearer, sent on every request — never
    // rode plain `http://` over a network. That worry is now answered where it
    // belongs: a hub that other machines can reach is refused at boot unless it has
    // a public address (B3), which clients dial with `https://` through the front
    // end that terminates TLS (A1); a hub nobody else can reach is on loopback.
    // `main.tsx` skips `LoginScreen` and connects with no token whenever `/health`
    // reports `authRequired: false`, the same "just connect" shape desktop/CLI
    // clients use against a login-less hub.
    if (handleWebAssets(WEB_ROOT, req, res)) return
    mcpRest.app(req, res)
  }
  const gatedDispatch = withRestAuth({
    getHubAuthRequired: () => hubAuthRequired,
    getSsoActive: () => boot.ssoActive,
    getHubAuth: () => hubAuth,
    getDb: () => db,
    next: dispatchRequest
  })
  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    // /health answers BEFORE the gate: a liveness probe has no credentials, and
    // it must keep answering even when auth is misconfigured.
    if (handleHealth(state, req, res)) return
    gatedDispatch(req, res)
  }
  const httpServer = createServer(handleRequest)

  // Reject cross-origin WS upgrades — see ws-origin.ts for the full reasoning.
  // The decision is a pure, unit-tested function; this is only the wiring.
  //
  // `loopbackBind` means "reachable ONLY from this machine": it listens on loopback
  // AND publishes no public address. The second half matters — a loopback hub behind
  // a same-box reverse proxy is the internet's browser, and must not be handed the
  // local-client allowances (file://, chrome://, "null", localhost). A hub that
  // other machines can reach accepts only no-Origin (non-browser) callers plus its
  // own configured public origin.
  const loopbackBind = !boot.reachable
  const allowedWsOrigins = resolveAllowedWebOrigins()
  const isAllowedWsOrigin = (origin: string | undefined): boolean =>
    wsOriginDecision({
      origin,
      requireLogin: switches.requireLogin,
      loopbackBind,
      allowedOrigins: allowedWsOrigins
    }) === 'accept'
  // Both WS endpoints ride the ONE `httpServer` as `noServer` handlers, demuxed by
  // path in the single `upgrade` listener below. A `server`-bound WSS would destroy
  // any socket whose path it doesn't own, so two endpoints on one server MUST both
  // be `noServer` + hand-demuxed. `noServer` also means `verifyClient` is never
  // invoked — the `/trpc` origin guard is applied inline in the demux instead (see
  // below).
  //
  //   /trpc      — clients (renderer / federated hubs), origin-guarded.
  //   /computers — computers (non-browser), NO origin allowlist (authenticated by the
  //                computer protocol: enroll/hello frames + join token).
  const wss = new WebSocketServer({ noServer: true })
  const computerWss = computerGateway ? new WebSocketServer({ noServer: true }) : null
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0]
    if (pathname === '/trpc') {
      // Origin guard (was verifyClient; noServer skips it). A drive-by web page or
      // DNS-rebind must not reach the full app router — native/loopback origins only.
      const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
      if (!isAllowedWsOrigin(origin)) {
        // A browser page from another origin (or a DNS rebind) tried to open the full
        // app router — the signature this guard exists for, so it is audited (T-03).
        securityEvent({
          event: 'authz.denied',
          outcome: 'denied',
          actor: null,
          ip: peerAddress(req),
          route: routeOf(req.method, req.url),
          detail: { reason: 'origin', origin: origin ?? null }
        })
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } else if (pathname === '/computers' && computerWss && computerGateway) {
      computerWss.handleUpgrade(req, socket, head, (ws) =>
        computerGateway.handleConnection(ws, { ip: peerAddress(req) })
      )
    } else {
      // No handler owns this path — reject rather than leave the socket dangling.
      socket.destroy()
    }
  })
  // createContext verifies the bearer only when this hub enforces auth
  // (`hubAuthRequired`, defined above). A hub with login off leaves it off →
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
      db,
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

  // PORT RESOLUTION. An explicit port (cfg / SLAYZONE_HUB_LISTEN_ADDRESS) binds verbatim
  // and fails loud on collision — that loudness is the point of the fixed
  // supervised ports. With NO port named, walk the hub port block instead of
  // taking an OS-assigned ephemeral one: `slay hub ls` discovers hubs by probing
  // that block, so an out-of-block hub is invisible to it. An explicit `:0` still
  // means "OS-assigned" per the hub address grammar (hub-addr.ts) and is
  // honored — such a hub is deliberately un-discoverable.
  const requestedPort = cfg.port ?? getTrpcPort()
  let actualPort: number
  if (requestedPort === undefined) {
    actualPort = await bindInHubPortBlock(httpServer, host)
  } else {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown): void => {
        httpServer.off('error', onError)
        reject(err)
      }
      httpServer.once('error', onError)
      httpServer.listen(requestedPort, host, () => {
        httpServer.off('error', onError)
        resolve()
      })
    })
    const addr = httpServer.address()
    actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort
  }
  state.port = actualPort
  state.ready = true
  composition.setBoundPort(actualPort)

  // Computer `/computers` rides the SAME listener as `/trpc` (bound above) — no
  // separate port to claim, no separate bind to fail. Feed the computers registry the
  // `ws(s)://…/computers` URL so `mintJoinToken` embeds it (A2): the public address
  // when one is set (a front end terminates TLS there, so `wss://` for any non-loopback
  // host), else the loopback address the hub is bound to. No certificate fingerprint
  // goes into the token — the hub presents no certificate of its own, so there is
  // nothing for a computer to pin.
  //
  // The computer URL's port is the hub port (stable via claimServerPort /
  // SIDECAR_FIXED_PORT), so the computer credential key (hubHostFromUrl → host_port)
  // stays stable across reboots WITHOUT a dedicated computer-port persistence layer.
  if (computerGateway) {
    const computerHubUrl = deriveComputerHubUrl({
      host,
      port: actualPort,
      publicAddress: boot.publicAddress
    })
    if (computerHubUrl) {
      composition.setComputerListenerInfo({ hubUrl: computerHubUrl })
      log(`computer transport ready on ${computerHubUrl}`)
    } else {
      // Defensive: boot rule B8 already refuses a malformed public address.
      // `mintJoinToken` then throws a clear "hub url unset" until fixed — the
      // /trpc path is unaffected.
      recordDiagnosticEvent({
        level: 'error',
        source: 'server',
        event: 'computer.hub_url_underivable',
        message: 'computer transport URL could not be derived (check SLAYZONE_HUB_PUBLIC_ADDRESS)'
      })
      log('computer transport URL could not be derived — computer enroll unavailable')
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
      supervised,
      switches
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
      // FIRST, before anything that can fire a pty/chat exit handler. Closing the
      // computer gateway below disposes every session on that computer, and each exit
      // would otherwise clear `terminal_tabs.was_spawned` — the exact flag the
      // next boot reads to bring your agents back (`listAutoRestoreTasks`).
      // Every quit path funnels here: SIGTERM/SIGINT, parent-pipe close and the
      // ppid-reparent poll in bin.ts all call `handle.stop()`.
      beginTerminalShutdown()
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
      // Terminate every computer connection + reject in-flight requests,
      // then close the computer WSS. No-op if the computer init failed (all null).
      if (computerGateway) {
        try {
          computerGateway.close()
        } catch {
          /* ignore */
        }
      }
      // `/computers` shares the one httpServer as a noServer WSS — close it to drop
      // the gateway sockets; there is no separate computer listener to close.
      if (computerWss) {
        try {
          computerWss.close()
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
