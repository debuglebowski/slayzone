/**
 * The `/trpc` socket context (one per WebSocket connection, applyWSSHandler's
 * `createContext`): the window id, the verified principal — and, on an authenticated
 * socket, `principalLive`, the synchronous per-operation check the tRPC liveness gate
 * runs before every operation and every subscription output (trpc-server `livenessGate`).
 *
 * WHY PER OPERATION. A socket resolves its principal once, when it opens. Revoking in
 * THIS process closes it (trpc-connections.ts `closeUser`), but a change made elsewhere —
 * another hub process activating the IdP-role mode or changing its config, revoking the
 * account, its evidence expiring while a refresh is still pending — would otherwise only
 * be seen at the next periodic sweep or deadline timer, and a socket opened with the mode
 * off has no deadline at all. `principalLive` reads PERSISTED state (hub-auth
 * `idpSessionLiveNow`: mode, epoch, config identity, disabled, grant watermark, evidence
 * age) synchronously, never waiting on the issuer; when it fails, that operation or
 * output is refused and the socket is closed — the client reconnects and the async gate
 * re-proves or refuses it.
 *
 * Login off (the desktop app's hub): no principal, no check — unchanged.
 *
 * @module hub/trpc-socket-context
 */
import type { IncomingMessage } from 'node:http'
import {
  captureGrant,
  type HubAuth,
  idpSessionLiveNow,
  type SessionBinding
} from '@slayzone/hub-auth/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { clientAddress } from '@slayzone/platform/client-address'
import { routeOf, securityEvent } from '@slayzone/platform/security-log'
import type { WebSocket } from 'ws'
import {
  type ConnectionPrincipal,
  connectionToken,
  parseWindowIdFromUrl,
  resolveConnectionPrincipal
} from './hub-trpc-context.js'
import { parseCookieHeader } from './rest-auth.js'
import { SESSION_ENDED_CLOSE_CODE, type TrpcConnectionRegistry } from './trpc-connections.js'

export interface HubTrpcContextDeps<Extra extends Record<string, unknown>> {
  /** Whether THIS hub enforces auth; off = no principal is ever resolved. */
  hubAuthRequired: boolean
  hubAuth: HubAuth | null
  db: SlayzoneDb
  connections: Pick<TrpcConnectionRegistry, 'track'>
  /** Is this upgrade from the hub's own page (cookie credential allowed)? */
  isCookieOriginAllowed: (req: IncomingMessage) => boolean
  /** Per-window socket tracking (warm-window-sockets.ts); absent in tests. */
  trackWindow?: (windowId: number, socket: WebSocket) => void
  /** Whatever else the app's procedures read from the context. */
  extra: Extra
}

/** How long after a refusal the socket is closed (the refusal frame goes out first). */
export const CLOSE_AFTER_REFUSAL_MS = 100

/** The `createContext` the hub hands applyWSSHandler. */
export function createHubTrpcContext<Extra extends Record<string, unknown>>(
  deps: HubTrpcContextDeps<Extra>
) {
  const { hubAuthRequired, hubAuth, db } = deps
  return async ({
    req,
    res,
    info
  }: {
    req: IncomingMessage
    res?: WebSocket
    info?: { connectionParams?: Record<string, string | undefined> | null }
  }) => {
    // windowId (?windowId=N) → ctx.windowId (claimSession, panel ownership, warm pool).
    const windowId = parseWindowIdFromUrl(req.url)
    if (windowId != null && res) deps.trackWindow?.(windowId, res)
    // The credential: the connectionParams token, else the web shell's session cookie
    // from the hub's own page only (T-13, `connectionToken`). Login off: neither is read.
    const presented = hubAuthRequired
      ? connectionToken({
          connectionParamsToken: info?.connectionParams?.token,
          cookies: parseCookieHeader(req.headers),
          cookieOriginAllowed: deps.isCookieOriginAllowed(req)
        })
      : null
    if (presented?.cookieRefused) {
      securityEvent({
        event: 'authz.denied',
        outcome: 'denied',
        actor: null,
        ip: clientAddress(req),
        route: routeOf(req.method, req.url),
        detail: { reason: 'cookie_origin', origin: req.headers.origin ?? null }
      })
    }
    const resolve = () =>
      resolveConnectionPrincipal({ hubAuthRequired, hubAuth, db, token: presented?.token })
    const principal: ConnectionPrincipal | null = await resolve()
    // T-12: tracked by its account — revoking the account closes it, its credential is
    // re-resolved periodically, and (IdP-role mode) it closes at its evidence deadline.
    if (principal && res) {
      deps.connections.track(res, principal.userId, async () => (await resolve())?.userId ?? null)
    }
    // Per-operation, synchronous, from persisted state (see the module note), bound to
    // what this socket was authorized with: its credential, the role its context carries
    // (a demotion anywhere ends a cached admin socket), the grant it was opened under.
    const binding: SessionBinding | null =
      principal && hubAuth
        ? {
            ...(principal.session ?? { createdAtMs: 0 }),
            role: principal.role,
            grantedAt: captureGrant(hubAuth, principal.userId)
          }
        : null
    let ended = false
    const principalLive =
      principal && hubAuth && binding
        ? (): boolean => {
            if (ended) return false
            const live = idpSessionLiveNow(hubAuth, principal.userId, binding)
            if (!live) {
              // From now on every check of this socket fails at once; the close follows
              // shortly, so the refusal (UNAUTHORIZED) reaches the client first.
              ended = true
              const t = setTimeout(() => {
                try {
                  res?.close(SESSION_ENDED_CLOSE_CODE, 'session no longer valid')
                } catch {
                  // Already closing.
                }
              }, CLOSE_AFTER_REFUSAL_MS)
              t.unref?.()
            }
            return live
          }
        : undefined
    return {
      db,
      req,
      windowId,
      principal,
      ...(principalLive ? { principalLive } : {}),
      ...deps.extra
    }
  }
}
