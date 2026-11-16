/**
 * DuplexRpc — generalized duplex JSON-RPC 2.0 endpoint for the computer protocol.
 *
 * Both peers (hub gateway and computer dialer) instantiate one of these over a
 * shared transport. Responsibility is *only* JSON-RPC framing — request-id
 * correlation, timeout bookkeeping, peer-request dispatch. It has no knowledge
 * of computer semantics (enroll, heartbeats, pty); that lives in the gateway and
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
 *  - Request timeouts count awake time only (`@slayzone/platform/suspend-clock`).
 *  - Every outbound frame is held to `maxFrameBytes` (UTF-8 bytes of the serialized
 *    document; default {@link COMPUTER_FRAME_MAX_BYTES}). The peer's transport would
 *    otherwise close the WHOLE connection on it (ws: 1009). Over the limit, a reply
 *    becomes a {@link FRAME_TOO_LARGE_CODE} error for its id, a request is rejected
 *    locally, a notification is dropped — each reported to `onFrameTooLarge`.
 *
 * @module computer/shared/rpc
 */

import {
  createAwakeTimeouts,
  type AwakeTimeouts,
  type DisposableSuspendClock
} from '@slayzone/platform/suspend-clock'
import { COMPUTER_FRAME_MAX_BYTES, FRAME_TOO_LARGE_CODE } from './frame-limit'

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

/** An outbound frame this endpoint refused to send because it exceeds the frame limit. */
export interface FrameTooLargeInfo {
  kind: 'request' | 'response' | 'notification'
  /** The request's method (for a reply: the method it answers); null when unknown. */
  method: string | null
  /** Request id (outbound request) or the peer request id being answered. */
  id?: JsonRpcId
  /** UTF-8 size of the serialized frame; null = too large to serialize at all. */
  bytes: number | null
  limitBytes: number
}

export interface DuplexRpcOptions {
  /** Write one framed JSON document (transport appends any newline framing). */
  write: (line: string) => void
  /**
   * Peer→local request (method + id). The handler must eventually call
   * `respond(id, ...)` or `respondError(id, ...)`. When omitted, requests are
   * auto-answered with -32601 so the peer never hangs.
   *
   * `actor` is the envelope's top-level `actor` member, raw (`undefined` when
   * absent) — see `requestActorSchema` in frames.ts. Validation is the caller's.
   */
  onPeerRequest?: (
    method: string,
    params: unknown,
    id: JsonRpcId,
    actor: unknown,
    signal: AbortSignal
  ) => void
  /** Peer→local notification (method, no id). */
  onNotification?: (method: string, params: unknown) => void
  /** A correlated reply (including a refusal) proves this peer is still answering. */
  onPeerResponse?: () => void
  /** Diagnostic hook for unparseable / malformed inbound frames. */
  onParseError?: (line: string, err: unknown) => void
  /**
   * Default per-request timeout; `<= 0` disables. Defaults to 30s. Counted in
   * awake time: a host sleep or event-loop freeze does not use it up — both peers
   * of a local computer sleep together, so neither could have answered.
   */
  defaultRequestTimeoutMs?: number
  /** Test seam: the awake-time source for request timeouts. */
  suspendClock?: () => DisposableSuspendClock
  /** Short name used in error messages (e.g. 'computer-hub'). */
  label?: string
  /**
   * Largest outbound frame, in UTF-8 bytes. Defaults to the computer protocol's
   * {@link COMPUTER_FRAME_MAX_BYTES} — must not exceed what the peer accepts.
   * `<= 0` disables the cap.
   */
  maxFrameBytes?: number
  /** Diagnostic hook for every frame refused by `maxFrameBytes`. Must not throw. */
  onFrameTooLarge?: (info: FrameTooLargeInfo) => void
  /**
   * Name a request (inbound or outbound) in frame-limit errors, diagnostics and
   * `pendingMethods()`. Default: its method. An envelope method (a relay that carries
   * another request in its params) names what it carries, so the caller learns
   * which request failed. Must be cheap; a throw falls back to the method.
   */
  describeRequest?: (method: string, params: unknown) => string
}

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  /** Cancels the timeout; null when the request has none. */
  cancelTimeout: (() => void) | null
  removeAbort: () => void
}

export const JSON_RPC_METHOD_NOT_FOUND = -32601
export const JSON_RPC_INTERNAL_ERROR = -32000

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** A method name as it appears in a message: the peer chose it, so bound it. */
function methodLabel(method: string | null): string {
  if (method === null) return 'an unknown request'
  return `'${method.length > 200 ? `${method.slice(0, 200)}…` : method}'`
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** The error a frame over the limit turns into — for the caller or the peer. */
function frameTooLargeError(
  what: 'reply to' | 'request',
  method: string | null,
  bytes: number | null,
  limitBytes: number
): RpcError {
  const size =
    bytes === null ? 'exceeds the JavaScript string limit' : `is ${bytes} bytes (${mib(bytes)})`
  return new RpcError(
    FRAME_TOO_LARGE_CODE,
    `${what} ${methodLabel(method)} ${size}; the frame limit is ${limitBytes} bytes (${mib(limitBytes)})`,
    {
      frame: what === 'request' ? 'request' : 'reply',
      method: method === null ? null : method.slice(0, 200),
      bytes,
      limitBytes
    }
  )
}

/** Room an error message may take when a too-large error reply is slimmed. */
function errorMessageBudget(limitBytes: number): number {
  // UTF-16 unit ≤ 3 UTF-8 bytes; leave most of the frame for the envelope and id.
  return Math.max(0, Math.min(8192, Math.floor(limitBytes / 8)))
}

type Encoded =
  | { kind: 'ok'; line: string }
  | { kind: 'too-large'; bytes: number | null }
  | { kind: 'unserializable'; error: Error }

export class DuplexRpc {
  private readonly opts: DuplexRpcOptions
  private readonly label: string
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly inboundAborts = new Map<JsonRpcId, AbortController>()
  private disposed = false
  private readonly timeouts: AwakeTimeouts
  /** Peer request id → method, until answered: names the method a refused reply was for. */
  private readonly inboundMethods = new Map<JsonRpcId, string>()
  readonly maxFrameBytes: number

  constructor(opts: DuplexRpcOptions) {
    this.opts = opts
    this.label = opts.label ?? 'computer-rpc'
    this.maxFrameBytes = opts.maxFrameBytes ?? COMPUTER_FRAME_MAX_BYTES
    this.timeouts = createAwakeTimeouts(opts.suspendClock ? { clock: opts.suspendClock } : {})
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Number of in-flight outbound requests (diagnostics/tests). */
  get pendingCount(): number {
    return this.pending.size
  }

  /** Methods of in-flight outbound requests, oldest first (diagnostics). */
  pendingMethods(): string[] {
    return [...this.pending.values()].map((p) => p.method)
  }

  /**
   * Issue a JSON-RPC request. Resolves with the `result` payload, rejects with
   * `RpcError` on a JSON-RPC error reply, `RpcTimeoutError` on timeout, or
   * `RpcDisposedError` on disposal. `timeoutMs <= 0` disables the timeout.
   *
   * `actor`, when given, rides as the envelope's top-level `actor` member (who
   * asked — hub → computer requests only; see `requestActorSchema`).
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    actor?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'))
    if (this.disposed) {
      return Promise.reject(new RpcDisposedError(this.label))
    }
    const effectiveTimeout =
      timeoutMs ?? this.opts.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const id = this.nextId++
    const encoded = this.encode({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
      ...(actor === undefined ? {} : { actor })
    })
    if (encoded.kind === 'unserializable') return Promise.reject(encoded.error)
    if (encoded.kind === 'too-large') {
      const name = this.describe(method, params)
      this.reportTooLarge({ kind: 'request', method: name, id, bytes: encoded.bytes })
      return Promise.reject(frameTooLargeError('request', name, encoded.bytes, this.maxFrameBytes))
    }
    if (signal?.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'))
    const envelope = encoded.line
    return new Promise<T>((resolve, reject) => {
      const removeAbort = () => signal?.removeEventListener('abort', abort)
      const abort = () => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.cancelTimeout?.()
        removeAbort()
        reject(new DOMException('Request aborted', 'AbortError'))
        // Request cancellation is advisory. The peer still owns physical cleanup.
        try {
          this.notify('$/cancelRequest', { id })
        } catch {
          /* Transport already lost. */
        }
      }
      const cancelTimeout =
        effectiveTimeout > 0
          ? this.timeouts.set(() => {
              this.pending.delete(id)
              removeAbort()
              reject(new RpcTimeoutError(method, effectiveTimeout, this.label))
            }, effectiveTimeout)
          : null
      this.pending.set(id, {
        method: this.describe(method, params),
        resolve: resolve as (r: unknown) => void,
        reject,
        cancelTimeout,
        removeAbort
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.opts.write(envelope)
      } catch (err) {
        this.pending.delete(id)
        cancelTimeout?.()
        removeAbort()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response expected). */
  /**
   * Over the frame limit it is dropped (reported to `onFrameTooLarge`), never
   * thrown: a notification has no caller to tell. Params that cannot be
   * serialized for another reason (a cycle) still throw — a programming error.
   */
  notify(method: string, params?: unknown): void {
    if (this.disposed) return
    const encoded = this.encode(
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
    )
    if (encoded.kind === 'unserializable') throw encoded.error
    if (encoded.kind === 'too-large') {
      this.reportTooLarge({ kind: 'notification', method, bytes: encoded.bytes })
      return
    }
    this.opts.write(encoded.line)
  }

  /**
   * Reply to a peer request with a success result. A result over the frame limit
   * (or too large to serialize) is answered with a `frameTooLarge` error instead,
   * so the peer's caller learns why and the connection stays up.
   */
  respond(id: JsonRpcId, result: unknown): void {
    if (this.disposed) return
    this.sendReply(id, { jsonrpc: '2.0', id, result: result ?? null })
  }

  /**
   * Reply to a peer request with an error. Held to the frame limit like `respond`,
   * but an error reply over it first keeps its code and (truncated) message without
   * `data` — the caller still learns the real failure; only if even that cannot fit
   * does it become `frameTooLarge`.
   */
  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    if (this.disposed) return
    this.sendReply(
      id,
      {
        jsonrpc: '2.0',
        id,
        error: data === undefined ? { code, message } : { code, message, data }
      },
      { code, message, hadData: data !== undefined }
    )
  }

  private sendReply(
    id: JsonRpcId,
    reply: Record<string, unknown>,
    asError?: { code: number; message: string; hadData: boolean }
  ): void {
    const method = this.inboundMethods.get(id) ?? null
    this.inboundMethods.delete(id)
    this.inboundAborts.delete(id)
    const encoded = this.encode(reply)
    if (encoded.kind === 'ok') {
      this.opts.write(encoded.line)
      return
    }
    if (encoded.kind === 'too-large')
      this.reportTooLarge({ kind: 'response', method, id, bytes: encoded.bytes })
    if (asError) {
      const slim = this.encode({
        jsonrpc: '2.0',
        id,
        error: { code: asError.code, message: this.slimMessage(asError, encoded.kind) }
      })
      if (slim.kind === 'ok') {
        this.opts.write(slim.line)
        return
      }
    }
    let error: { code: number; message: string; data?: unknown }
    if (encoded.kind === 'too-large') {
      const err = frameTooLargeError('reply to', method, encoded.bytes, this.maxFrameBytes)
      error = { code: err.code, message: err.message, data: err.data }
    } else {
      error = {
        code: JSON_RPC_INTERNAL_ERROR,
        message: `reply to ${methodLabel(method)} could not be serialized: ${encoded.error.message}`
      }
    }
    this.opts.write(JSON.stringify({ jsonrpc: '2.0', id, error }))
  }

  /** An error message cut to fit, saying what was cut and why. */
  private slimMessage(
    error: { message: string; hadData: boolean },
    why: 'too-large' | 'unserializable'
  ): string {
    const budget = errorMessageBudget(this.maxFrameBytes)
    const cut = error.message.length > budget
    const notes: string[] = []
    if (cut) notes.push('message truncated')
    if (error.hadData)
      notes.push(
        why === 'too-large'
          ? 'error data omitted: over the frame limit'
          : 'error data omitted: not serializable'
      )
    const text = cut ? `${error.message.slice(0, budget)}…` : error.message
    return notes.length ? `${text} [${notes.join('; ')}]` : text
  }

  private describe(method: string, params: unknown): string {
    if (!this.opts.describeRequest) return method
    try {
      return this.opts.describeRequest(method, params) || method
    } catch {
      return method
    }
  }

  /**
   * Serialize one outbound document and hold it to the frame limit. Characters
   * are not bytes: a UTF-16 unit is at most 3 UTF-8 bytes, so only a line longer
   * than a third of the limit is measured.
   */
  private encode(doc: Record<string, unknown>): Encoded {
    let line: string
    try {
      line = JSON.stringify(doc)
    } catch (err) {
      // V8 refuses strings over ~512 MiB ('Invalid string length'): the frame is
      // larger than any limit. A deep-nesting RangeError is not a size problem.
      if (err instanceof RangeError && /string length/i.test(err.message))
        return { kind: 'too-large', bytes: null }
      return { kind: 'unserializable', error: err instanceof Error ? err : new Error(String(err)) }
    }
    const limit = this.maxFrameBytes
    if (limit > 0 && line.length * 3 > limit) {
      const bytes = Buffer.byteLength(line, 'utf8')
      if (bytes > limit) return { kind: 'too-large', bytes }
    }
    return { kind: 'ok', line }
  }

  private reportTooLarge(info: Omit<FrameTooLargeInfo, 'limitBytes'>): void {
    try {
      this.opts.onFrameTooLarge?.({ ...info, limitBytes: this.maxFrameBytes })
    } catch {
      // A diagnostic must never change what is sent.
    }
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
      (typeof rawId === 'string' && rawId.length > 0) ||
      (typeof rawId === 'number' && Number.isFinite(rawId))
    const isResponse = hasId && ('result' in msg || 'error' in msg) && !('method' in msg)

    if (isResponse) {
      this.resolvePending(rawId as JsonRpcId, msg)
      return
    }

    if (typeof msg.method === 'string') {
      if (hasId) {
        const abort = new AbortController()
        // Never replace an accepted request's cancellation identity.
        if (this.inboundAborts.has(rawId as JsonRpcId)) return
        this.inboundMethods.set(rawId as JsonRpcId, this.describe(msg.method, msg.params))
        this.inboundAborts.set(rawId as JsonRpcId, abort)
        if (this.opts.onPeerRequest) {
          this.opts.onPeerRequest(
            msg.method,
            msg.params,
            rawId as JsonRpcId,
            msg.actor,
            abort.signal
          )
        } else {
          this.respondError(
            rawId as JsonRpcId,
            JSON_RPC_METHOD_NOT_FOUND,
            `method not found: ${msg.method}`
          )
        }
      } else if (msg.method === '$/cancelRequest') {
        const id = (msg.params as { id?: unknown } | null)?.id
        if (typeof id === 'string' || typeof id === 'number') this.inboundAborts.get(id)?.abort()
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
    this.inboundMethods.clear()
    for (const abort of this.inboundAborts.values()) abort.abort()
    this.inboundAborts.clear()
    for (const [id, pending] of this.pending) {
      pending.cancelTimeout?.()
      pending.removeAbort()
      pending.reject(new RpcDisposedError(this.label, reason))
      this.pending.delete(id)
    }
  }

  private resolvePending(id: JsonRpcId, msg: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return // late reply after timeout/disposal — expected, not an error
    this.opts.onPeerResponse?.()
    this.pending.delete(id)
    pending.cancelTimeout?.()
    pending.removeAbort()
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

  /** The unterminated tail fed so far (the frame still being received). */
  get partial(): string {
    return this.buffer
  }

  /** Flush any trailing partial line (e.g. at stream end). */
  flush(): string | null {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest.length > 0 ? rest : null
  }
}
