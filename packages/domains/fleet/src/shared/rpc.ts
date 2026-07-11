/**
 * DuplexRpc — generalized duplex JSON-RPC 2.0 endpoint for the fleet protocol.
 *
 * Both peers (hub gateway and runner dialer) instantiate one of these over a
 * shared transport. Responsibility is *only* JSON-RPC framing — request-id
 * correlation, timeout bookkeeping, peer-request dispatch. It has no knowledge
 * of fleet semantics (enroll, heartbeats, pty); that lives in the gateway and
 * dialer. The split keeps this class unit-testable against canned NDJSON.
 *
 * Transport contract: `write(line)` sends exactly one JSON document with no
 * trailing newline — the transport owns framing (newline-delimited on byte
 * streams, one message per frame on WebSocket). Inbound, feed one document per
 * `handleLine()` call; `LineDecoder` below helps chunked byte-stream
 * transports.
 *
 * Wire notes:
 *  - Outbound requests/notifications/responses all carry `jsonrpc:"2.0"`.
 *  - Inbound responses are correlated purely by `id` (`jsonrpc` optional).
 *  - Inbound peer requests carry both `method` and `id`.
 *  - Inbound notifications carry `method` and no `id`.
 *  - A response for an unknown/expired id is silently ignored (a reply racing
 *    its own timeout is expected, not a protocol error).
 *
 * @module fleet/shared/rpc
 */

export type JsonRpcId = string | number

export interface JsonRpcErrorShape {
  code: number
  message: string
  data?: unknown
}

/** Error thrown/rejected when the peer replies with a JSON-RPC `error` object. */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
  static fromShape(err: JsonRpcErrorShape): RpcError {
    return new RpcError(err.code, err.message, err.data)
  }
}

/** Rejection for a request that received no reply within its timeout. */
export class RpcTimeoutError extends Error {
  readonly method: string
  readonly timeoutMs: number
  constructor(method: string, timeoutMs: number, label: string) {
    super(`${label} request '${method}' timed out after ${timeoutMs}ms`)
    this.name = 'RpcTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

/** Rejection for requests in flight when the endpoint is disposed. */
export class RpcDisposedError extends Error {
  constructor(label: string, reason?: string) {
    super(reason ? `${label} closed: ${reason}` : `${label} closed`)
    this.name = 'RpcDisposedError'
  }
}

export interface DuplexRpcOptions {
  /** Write one framed JSON document (transport appends any newline framing). */
  write: (line: string) => void
  /**
   * Peer→local request (method + id). The handler must eventually call
   * `respond(id, ...)` or `respondError(id, ...)`. When omitted, requests are
   * auto-answered with -32601 so the peer never hangs.
   */
  onPeerRequest?: (method: string, params: unknown, id: JsonRpcId) => void
  /** Peer→local notification (method, no id). */
  onNotification?: (method: string, params: unknown) => void
  /** Diagnostic hook for unparseable / malformed inbound frames. */
  onParseError?: (line: string, err: unknown) => void
  /** Default per-request timeout; `<= 0` disables. Defaults to 30s. */
  defaultRequestTimeoutMs?: number
  /** Short name used in error messages (e.g. 'fleet-hub'). */
  label?: string
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export const JSON_RPC_METHOD_NOT_FOUND = -32601
export const JSON_RPC_INTERNAL_ERROR = -32000

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class DuplexRpc {
  private readonly opts: DuplexRpcOptions
  private readonly label: string
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private disposed = false

  constructor(opts: DuplexRpcOptions) {
    this.opts = opts
    this.label = opts.label ?? 'fleet-rpc'
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Number of in-flight outbound requests (diagnostics/tests). */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Issue a JSON-RPC request. Resolves with the `result` payload, rejects with
   * `RpcError` on a JSON-RPC error reply, `RpcTimeoutError` on timeout, or
   * `RpcDisposedError` on disposal. `timeoutMs <= 0` disables the timeout.
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new RpcDisposedError(this.label))
    }
    const effectiveTimeout = timeoutMs ?? this.opts.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const id = this.nextId++
    const envelope = JSON.stringify(
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params }
    )
    return new Promise<T>((resolve, reject) => {
      const timer =
        effectiveTimeout > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new RpcTimeoutError(method, effectiveTimeout, this.label))
            }, effectiveTimeout)
          : null
      this.pending.set(id, {
        resolve: resolve as (r: unknown) => void,
        reject,
        timer
      })
      try {
        this.opts.write(envelope)
      } catch (err) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.disposed) return
    this.opts.write(
      JSON.stringify(
        params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
      )
    )
  }

  /** Reply to a peer request with a success result. */
  respond(id: JsonRpcId, result: unknown): void {
    if (this.disposed) return
    this.opts.write(JSON.stringify({ jsonrpc: '2.0', id, result: result ?? null }))
  }

  /** Reply to a peer request with an error. */
  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    if (this.disposed) return
    this.opts.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: data === undefined ? { code, message } : { code, message, data }
      })
    )
  }

  /**
   * Feed one inbound JSON document. Routes responses to pending requests, peer
   * requests to `onPeerRequest`, and notifications to `onNotification`.
   * Never throws — malformed input goes to `onParseError`.
   */
  handleLine(line: string): void {
    if (this.disposed) return
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.opts.onParseError?.(trimmed, new Error('non-object JSON-RPC message'))
        return
      }
      msg = parsed as Record<string, unknown>
    } catch (err) {
      this.opts.onParseError?.(trimmed, err)
      return
    }

    const rawId = msg.id
    const hasId =
      (typeof rawId === 'string' && rawId.length > 0) || (typeof rawId === 'number' && Number.isFinite(rawId))
    const isResponse = hasId && ('result' in msg || 'error' in msg) && !('method' in msg)

    if (isResponse) {
      this.resolvePending(rawId as JsonRpcId, msg)
      return
    }

    if (typeof msg.method === 'string') {
      if (hasId) {
        if (this.opts.onPeerRequest) {
          this.opts.onPeerRequest(msg.method, msg.params, rawId as JsonRpcId)
        } else {
          this.respondError(rawId as JsonRpcId, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${msg.method}`)
        }
      } else {
        this.opts.onNotification?.(msg.method, msg.params)
      }
      return
    }

    this.opts.onParseError?.(trimmed, new Error('unrecognized JSON-RPC message shape'))
  }

  /** Reject every pending request and stop accepting new ones. */
  dispose(reason?: string): void {
    if (this.disposed) return
    this.disposed = true
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new RpcDisposedError(this.label, reason))
      this.pending.delete(id)
    }
  }

  private resolvePending(id: JsonRpcId, msg: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return // late reply after timeout/disposal — expected, not an error
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if ('error' in msg && msg.error) {
      const e = msg.error as JsonRpcErrorShape
      pending.reject(
        RpcError.fromShape({
          code: typeof e.code === 'number' ? e.code : JSON_RPC_INTERNAL_ERROR,
          message: typeof e.message === 'string' ? e.message : 'unknown error',
          data: e.data
        })
      )
    } else {
      pending.resolve(msg.result)
    }
  }
}

/**
 * Incremental newline-delimited decoder for byte-stream transports. WebSocket
 * transports (one document per message) do not need it, but should still split
 * on `\n` defensively to tolerate batched frames.
 */
export class LineDecoder {
  private buffer = ''

  /** Feed a chunk; returns every complete line accumulated so far. */
  feed(chunk: string): string[] {
    this.buffer += chunk
    const parts = this.buffer.split('\n')
    this.buffer = parts.pop() ?? ''
    return parts.filter((p) => p.trim().length > 0)
  }

  /** Flush any trailing partial line (e.g. at stream end). */
  flush(): string | null {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest.length > 0 ? rest : null
  }
}
