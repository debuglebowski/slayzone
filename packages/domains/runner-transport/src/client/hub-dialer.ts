/**
 * Runner-side hub dialer. Owns the single outbound WebSocket to the hub and
 * the full session lifecycle:
 *
 *  - dial `wss://hub/...` (optionally pinning the hub's TLS cert by sha256)
 *  - authenticate: `hello` with stored credentials, falling back to `enroll`
 *    with the join token (credentials are persisted via the injected store)
 *  - heartbeat loop — an unanswered heartbeat tears the socket down
 *  - reconnect with exponential backoff; a rejected join token is fatal
 *
 * Hub→runner requests are dispatched to `onHubRequest`; `ping` is answered
 * internally. The dialer knows nothing about pty/fs/git semantics.
 *
 * @module runner/client/hub-dialer
 */

import { randomUUID } from 'node:crypto'
import type { PeerCertificate, TLSSocket } from 'node:tls'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import { TypedEventEmitter } from '../shared/events'
import {
  enrollResultSchema,
  RUNNER_PROTOCOL_VERSION,
  RunnerTransportErrorCodes,
  helloResultSchema,
  HubToRunnerMethods,
  RunnerToHubMethods
} from '../shared/frames'
import {
  certMatchesFingerprint,
  certSha256FingerprintFromDer,
  normalizeCertSha256Fingerprint
} from '../shared/pinning'
import { DuplexRpc, JSON_RPC_INTERNAL_ERROR, RpcError } from '../shared/rpc'
import { wsDataToText } from '../shared/ws-data'
import { computeBackoffDelayMs, type BackoffOptions } from './backoff'
import type { RunnerCredentialStore } from './credential-store'

export type HubDialerState = 'stopped' | 'connecting' | 'authenticating' | 'connected' | 'waiting-retry'

export interface RunnerIdentity {
  name: string
  /** `${process.platform}-${process.arch}`. */
  platform: string
  version: string
  capabilities: string[]
}

export type HubDialerEvents = {
  'state-change': { state: HubDialerState }
  connected: { runnerId: string; mode: 'enroll' | 'hello' }
  disconnected: { reason: string }
  'reconnect-scheduled': { attempt: number; delayMs: number }
  /**
   * `fatal: true` means the dialer gave up (bad join token, missing creds…).
   *
   * `reason: 'needs-re-enrollment'` is the one an operator can act on: the hub
   * refused this runner's stored api key, so the runner's identity no longer
   * exists as far as the hub is concerned. That is always the result of a human
   * action — storage deleted, one of the two DBs restored without the other, or
   * the runner revoked — so the fix is to enroll it again, not to retry. Callers
   * should surface it rather than string-matching the message.
   */
  error: { error: Error; fatal: boolean; reason?: 'needs-re-enrollment' }
  /** Hub→runner notification (none defined in protocol v1; future-proofing). */
  notification: { method: string; params: unknown }
}

export interface HubDialerOptions {
  /** `ws://` or `wss://` hub runner endpoint. */
  url: string
  identity: RunnerIdentity
  credentialStore: RunnerCredentialStore
  /** Required for first contact; reconnects use stored credentials. */
  joinToken?: string
  /**
   * Obtain a FRESH join token. Called only when enrollment is needed and the
   * configured `joinToken` has already been refused — i.e. the one-shot recovery
   * path below.
   *
   * Why this exists: join tokens are SINGLE-USE. If a stored api key ever fails
   * verification (a rebuilt hub-auth DB, a wiped `runners` row, a restored
   * backup), the dialer falls back to enrolling — with a token it already spent.
   * The hub answers "join token rejected: unknown", which is an explicit refusal,
   * so it was treated as fatal and the runner never came back until its process
   * was restarted. With runners as the only execution path, that means nothing
   * can run at all.
   *
   * Return `null` when a token cannot be minted; enrollment then fails as before.
   * Absent → today's behavior exactly (no re-mint, refusal is fatal).
   */
  refreshJoinToken?: () => Promise<string | null>
  /** Lowercase-hex sha256 of the hub leaf cert DER (colons tolerated). wss only. */
  pinnedCertSha256?: string
  /**
   * Handle a hub→runner request; resolve with the result or throw an
   * `RpcError` to control the error code. When omitted, every request is
   * answered with `-32001 unimplemented`.
   */
  onHubRequest?: (method: string, params: unknown) => Promise<unknown> | unknown
  /** Default 15s; `0` disables the loop. */
  heartbeatIntervalMs?: number
  /** Reply window for one heartbeat before the socket is torn down. Default 10s. */
  heartbeatTimeoutMs?: number
  /** Default timeout for runner→hub requests. Default 30s. */
  requestTimeoutMs?: number
  backoff?: Partial<BackoffOptions>
  /**
   * Override this process's epoch (see {@link PROCESS_EPOCH}). Only tests should
   * set it — two dialers in ONE process share the module-level epoch, so
   * simulating a runner RESTART (rather than a reconnect) requires saying so.
   */
  epoch?: string
  /** Injectable randomness for backoff jitter (tests). */
  random?: () => number
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * This runner PROCESS's epoch — minted once at module load, sent on every
 * enroll/hello. Constant across all of this process's reconnects, different in
 * any restarted process, which is exactly what lets the hub tell "my socket
 * dropped" from "the runner died" and reattach to still-live pty sessions
 * instead of declaring them dead. See `epochField` in shared/frames.
 */
const PROCESS_EPOCH = randomUUID()

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000

interface Connection {
  ws: WebSocket
  rpc: DuplexRpc
  heartbeatTimer: ReturnType<typeof setInterval> | null
  heartbeatInFlight: boolean
  authenticated: boolean
}

export class HubDialer {
  readonly events: TypedEventEmitter<HubDialerEvents>

  private readonly opts: HubDialerOptions
  private readonly log: (message: string, meta?: Record<string, unknown>) => void
  private readonly pinnedFingerprint: string | null

  private stateValue: HubDialerState = 'stopped'
  private current: Connection | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private runnerIdValue: string | null = null
  private stopping = false
  private fatalStop = false
  /** Fresh token from `refreshJoinToken`, preferred over `opts.joinToken` once set. */
  private currentJoinToken: string | null = null
  /** One re-mint per connection attempt, so a hub that refuses every token cannot
   *  become a mint loop. Reset on each new connection. */
  private triedTokenRefresh = false

  constructor(opts: HubDialerOptions) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
    this.events = new TypedEventEmitter<HubDialerEvents>((event, err) => {
      this.log('runner dialer listener threw', { event: String(event), error: String(err) })
    })
    const protocol = new URL(opts.url).protocol
    if (protocol !== 'ws:' && protocol !== 'wss:') {
      throw new Error(`hub url must be ws:// or wss://, got '${opts.url}'`)
    }
    if (opts.pinnedCertSha256 !== undefined) {
      if (protocol !== 'wss:') {
        throw new Error('pinnedCertSha256 requires a wss:// hub url')
      }
      this.pinnedFingerprint = normalizeCertSha256Fingerprint(opts.pinnedCertSha256)
    } else {
      this.pinnedFingerprint = null
    }
  }

  get state(): HubDialerState {
    return this.stateValue
  }

  /** Set once authenticated; survives reconnects. */
  get runnerId(): string | null {
    return this.runnerIdValue
  }

  /** This process's incarnation id, sent on every enroll/hello. */
  private get epoch(): string {
    return this.opts.epoch ?? PROCESS_EPOCH
  }

  start(): void {
    if (this.stateValue !== 'stopped') return
    this.stopping = false
    this.fatalStop = false
    this.retryAttempt = 0
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const conn = this.current
    if (conn) {
      const closed = new Promise<void>((resolve) => conn.ws.once('close', () => resolve()))
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1000, 'runner-stop')
      } else {
        conn.ws.terminate()
      }
      await closed
    }
    this.setState('stopped')
  }

  /**
   * Fire-and-forget notification to the hub (e.g. `pty.data`). Returns false
   * when not connected — callers relying on delivery must buffer and replay
   * via the seq protocol.
   */
  notify(method: string, params?: unknown): boolean {
    const conn = this.current
    if (!conn?.authenticated || conn.rpc.isDisposed) return false
    conn.rpc.notify(method, params)
    return true
  }

  /** Runner→hub request. Rejects when not connected. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const conn = this.current
    if (!conn?.authenticated || conn.rpc.isDisposed) {
      return Promise.reject(new Error('runner dialer is not connected to the hub'))
    }
    return conn.rpc.request<T>(method, params, timeoutMs)
  }

  // -------------------------------------------------------------------------

  private setState(state: HubDialerState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    this.events.emit('state-change', { state })
  }

  private buildWsOptions(): ClientOptions {
    if (!this.pinnedFingerprint) return {}
    const expected = this.pinnedFingerprint
    const tlsOptions = {
      // The pin *replaces* CA-chain trust — hubs present self-signed certs.
      // NOTE: with rejectUnauthorized:false node records a checkServerIdentity
      // failure in socket.authorizationError but does NOT abort the handshake,
      // so the pin is ENFORCED in verifyPinnedCert() (ws 'upgrade' event) —
      // this override only makes the failure observable early.
      rejectUnauthorized: false,
      checkServerIdentity: (_host: string, cert: PeerCertificate): Error | undefined => {
        if (!cert?.raw) return new Error('hub presented no certificate')
        if (!certMatchesFingerprint(expected, cert.raw)) {
          const actual = certSha256FingerprintFromDer(cert.raw)
          return new Error(`hub certificate fingerprint mismatch: expected ${expected}, got ${actual}`)
        }
        return undefined
      }
    }
    // @types/ws mistypes checkServerIdentity as `(…) => boolean` over CertMeta;
    // ws forwards these straight to tls.connect, which expects the node:tls
    // signature used above.
    return tlsOptions as unknown as ClientOptions
  }

  /**
   * Hard pin enforcement. Runs on the ws 'upgrade' event — after the TLS
   * handshake and the (secret-free) HTTP upgrade request, but before 'open',
   * so no runner frame (hello/enroll credentials) is ever sent to an unpinned
   * peer. Returns false and tears the socket down on mismatch.
   */
  private verifyPinnedCert(ws: WebSocket, tlsSocket: TLSSocket): boolean {
    const expected = this.pinnedFingerprint
    if (!expected) return true
    const cert =
      typeof tlsSocket.getPeerCertificate === 'function' ? tlsSocket.getPeerCertificate() : null
    const raw = cert && cert.raw ? cert.raw : null
    if (raw && certMatchesFingerprint(expected, raw)) return true
    const actual = raw ? certSha256FingerprintFromDer(raw) : 'no certificate'
    const error = new Error(`hub certificate fingerprint mismatch: expected ${expected}, got ${actual}`)
    this.log('runner dialer rejected hub certificate', { error: error.message })
    this.events.emit('error', { error, fatal: false })
    ws.terminate()
    return false
  }

  private connect(): void {
    this.retryTimer = null
    // Per-connection guard: a fresh attempt may legitimately need to re-mint again
    // (e.g. the hub was rebuilt between attempts), but within ONE attempt only once.
    this.triedTokenRefresh = false
    this.setState('connecting')
    const ws = new WebSocket(this.opts.url, this.buildWsOptions())
    const conn: Connection = {
      ws,
      rpc: null as unknown as DuplexRpc,
      heartbeatTimer: null,
      heartbeatInFlight: false,
      authenticated: false
    }
    conn.rpc = new DuplexRpc({
      label: 'runner-runner',
      defaultRequestTimeoutMs: this.opts.requestTimeoutMs,
      write: (line) => {
        ws.send(line)
      },
      onPeerRequest: (method, params, id) => this.handleHubRequest(conn, method, params, id),
      onNotification: (method, params) => this.events.emit('notification', { method, params }),
      onParseError: (line, err) => {
        this.log('runner dialer received malformed frame', { error: String(err), line })
      }
    })
    this.current = conn

    if (this.pinnedFingerprint) {
      ws.on('upgrade', (response) => {
        this.verifyPinnedCert(ws, response.socket as TLSSocket)
      })
    }
    ws.on('open', () => {
      if (this.current === conn && !this.stopping) void this.authenticate(conn)
    })
    ws.on('message', (data) => {
      for (const line of wsDataToText(data).split('\n')) {
        if (line.trim().length > 0) conn.rpc.handleLine(line)
      }
    })
    ws.on('error', (err) => {
      if (this.current !== conn) return
      this.log('runner dialer socket error', { error: String(err) })
      this.events.emit('error', { error: err instanceof Error ? err : new Error(String(err)), fatal: false })
    })
    ws.on('close', (code, reasonBuf) => {
      this.handleClose(conn, code, reasonBuf.toString())
    })
  }

  /** One `enroll` round-trip with the given token. Throws on any failure. */
  private async enroll(
    conn: Connection,
    joinToken: string
  ): Promise<{ runnerId: string; apiKey: string }> {
    const raw = await conn.rpc.request(RunnerToHubMethods.enroll, {
      joinToken,
      name: this.opts.identity.name,
      platform: this.opts.identity.platform,
      version: this.opts.identity.version,
      capabilities: this.opts.identity.capabilities,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      epoch: this.epoch
    })
    return enrollResultSchema.parse(raw)
  }

  private async authenticate(conn: Connection): Promise<void> {
    this.setState('authenticating')
    try {
      const stored = await this.opts.credentialStore.load()
      if (stored) {
        try {
          const raw = await conn.rpc.request(RunnerToHubMethods.hello, {
            apiKey: stored.apiKey,
            epoch: this.epoch
          })
          const result = helloResultSchema.parse(raw)
          this.onAuthenticated(conn, result.runnerId, 'hello')
          return
        } catch (err) {
          // Only an explicit credential rejection means the stored key is
          // dead. Transient hub-side RpcErrors and socket failures both go to
          // the reconnect path (rethrow → outer catch → backoff).
          if (!(err instanceof RpcError) || err.code !== RunnerTransportErrorCodes.unauthorized) throw err
          if (!this.opts.joinToken) {
            this.fatal(
              new Error(
                `This runner needs to be enrolled again: the hub rejected its stored ` +
                  `credentials, so the hub no longer recognizes this runner. ` +
                  `Enroll it from Settings → Runners (or \`slay runner enroll\`). (${err.message})`
              ),
              conn,
              'needs-re-enrollment'
            )
            return
          }
          this.log('runner dialer hello rejected — hub does not recognize this runner', {
            code: err.code
          })
        }
      }
      if (!this.opts.joinToken) {
        this.fatal(new Error('no stored credentials and no join token configured'), conn)
        return
      }
      let result
      try {
        result = await this.enroll(conn, this.currentJoinToken ?? this.opts.joinToken)
      } catch (err) {
        // An explicit refusal cannot succeed on retry with the SAME inputs. A
        // protocol mismatch is unfixable, so it stays fatal. An `unauthorized`
        // refusal usually means the token was already spent — which a FRESH token
        // does fix, so try to mint one and enroll once more before giving up.
        // Without this, one bad api-key verification retired the runner for the
        // lifetime of its process.
        const explicitlyRefused =
          err instanceof RpcError &&
          (err.code === RunnerTransportErrorCodes.unauthorized ||
            err.code === RunnerTransportErrorCodes.protocolMismatch)
        if (!explicitlyRefused) throw err

        const retriable =
          err instanceof RpcError &&
          err.code === RunnerTransportErrorCodes.unauthorized &&
          this.opts.refreshJoinToken !== undefined &&
          !this.triedTokenRefresh
        if (!retriable) {
          const isAuth =
            err instanceof RpcError && err.code === RunnerTransportErrorCodes.unauthorized
          this.fatal(
            new Error(
              isAuth
                ? `This runner needs to be enrolled again: the hub refused its join token ` +
                  `(a join token is single-use). Enroll it from Settings → Runners ` +
                  `(or \`slay runner enroll\`). (${err instanceof Error ? err.message : String(err)})`
                : `hub rejected enrollment (${(err as RpcError).code}): ${err instanceof Error ? err.message : String(err)}`
            ),
            conn,
            isAuth ? 'needs-re-enrollment' : undefined
          )
          return
        }

        // One attempt only, per connection, so a hub that refuses every token
        // cannot become a mint loop.
        this.triedTokenRefresh = true
        this.log('runner dialer enrollment refused — minting a fresh join token')
        let fresh: string | null = null
        try {
          fresh = await this.opts.refreshJoinToken!()
        } catch (mintErr) {
          this.log('runner dialer join-token mint failed', { error: String(mintErr) })
        }
        if (!fresh) {
          this.fatal(new Error(`hub rejected enrollment and no fresh join token could be minted: ${err instanceof Error ? err.message : String(err)}`), conn)
          return
        }
        this.currentJoinToken = fresh
        try {
          result = await this.enroll(conn, fresh)
        } catch (retryErr) {
          if (
            retryErr instanceof RpcError &&
            (retryErr.code === RunnerTransportErrorCodes.unauthorized ||
              retryErr.code === RunnerTransportErrorCodes.protocolMismatch)
          ) {
            this.fatal(
              new Error(`hub rejected enrollment with a fresh token (${retryErr.code}): ${retryErr.message}`),
              conn
            )
            return
          }
          throw retryErr
        }
      }
      try {
        await this.opts.credentialStore.save({
          runnerId: result.runnerId,
          apiKey: result.apiKey,
          ...(this.pinnedFingerprint ? { pinnedFingerprint: this.pinnedFingerprint } : {})
        })
      } catch (err) {
        // Persistence failure must not burn the freshly minted credentials
        // (join tokens may be single-use): keep the session, surface the
        // problem, and rely on re-enroll only if the process restarts.
        const error = new Error(
          `failed to persist runner credentials: ${err instanceof Error ? err.message : String(err)}`
        )
        this.log('runner dialer credential save failed', { error: error.message })
        this.events.emit('error', { error, fatal: false })
      }
      this.onAuthenticated(conn, result.runnerId, 'enroll')
    } catch (err) {
      if (this.current !== conn || this.stopping) return
      // Socket-level failure mid-auth — let the close handler drive the retry.
      this.log('runner dialer authentication interrupted', { error: String(err) })
      conn.ws.terminate()
    }
  }

  private onAuthenticated(conn: Connection, runnerId: string, mode: 'enroll' | 'hello'): void {
    if (this.current !== conn || this.stopping) return
    conn.authenticated = true
    this.runnerIdValue = runnerId
    this.retryAttempt = 0
    this.setState('connected')
    this.startHeartbeat(conn)
    this.events.emit('connected', { runnerId, mode })
    this.log('runner dialer connected', { runnerId, mode })
  }

  private startHeartbeat(conn: Connection): void {
    const intervalMs = this.opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    if (intervalMs <= 0) return
    const timeoutMs = this.opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    conn.heartbeatTimer = setInterval(() => {
      if (conn.heartbeatInFlight || conn.rpc.isDisposed) return
      conn.heartbeatInFlight = true
      conn.rpc
        .request(RunnerToHubMethods.heartbeat, { ts: Date.now() }, timeoutMs)
        .then(() => {
          conn.heartbeatInFlight = false
        })
        .catch((err: unknown) => {
          conn.heartbeatInFlight = false
          if (this.current !== conn || conn.rpc.isDisposed) return
          this.log('runner dialer heartbeat failed, dropping connection', { error: String(err) })
          conn.ws.terminate()
        })
    }, intervalMs)
    conn.heartbeatTimer.unref?.()
  }

  private handleHubRequest(conn: Connection, method: string, params: unknown, id: string | number): void {
    if (method === HubToRunnerMethods.ping) {
      conn.rpc.respond(id, { ts: Date.now() })
      return
    }
    const handler = this.opts.onHubRequest
    if (!handler) {
      conn.rpc.respondError(id, RunnerTransportErrorCodes.unimplemented, `unimplemented: ${method}`)
      return
    }
    void (async () => {
      try {
        const result = await handler(method, params)
        conn.rpc.respond(id, result ?? null)
      } catch (err) {
        if (err instanceof RpcError) {
          conn.rpc.respondError(id, err.code, err.message, err.data)
        } else {
          conn.rpc.respondError(
            id,
            JSON_RPC_INTERNAL_ERROR,
            err instanceof Error ? err.message : String(err)
          )
        }
      }
    })()
  }

  private handleClose(conn: Connection, code: number, reason: string): void {
    if (this.current !== conn) return
    this.current = null
    if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer)
    conn.rpc.dispose('socket closed')
    const detail = reason.trim().length > 0 ? reason : `socket closed (${code})`
    this.events.emit('disconnected', { reason: detail })
    if (this.stopping || this.fatalStop) {
      this.setState('stopped')
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.retryAttempt += 1
    const delayMs = computeBackoffDelayMs(this.retryAttempt, this.opts.backoff, this.opts.random)
    this.setState('waiting-retry')
    this.events.emit('reconnect-scheduled', { attempt: this.retryAttempt, delayMs })
    this.retryTimer = setTimeout(() => {
      if (!this.stopping && !this.fatalStop) this.connect()
    }, delayMs)
    this.retryTimer.unref?.()
  }

  private fatal(error: Error, conn: Connection, reason?: 'needs-re-enrollment'): void {
    // A stale authenticate() racing a reconnect must not kill the live
    // session that replaced it.
    if (this.current !== conn) return
    if (this.fatalStop) return
    this.fatalStop = true
    this.events.emit('error', { error, fatal: true, ...(reason ? { reason } : {}) })
    this.log('runner dialer fatal error', { error: error.message })
    conn.ws.terminate()
  }
}
