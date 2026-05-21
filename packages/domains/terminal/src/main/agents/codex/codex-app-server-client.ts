/**
 * CodexAppServerClient — hand-rolled JSON-RPC 2.0 client for the Codex CLI's
 * `codex app-server` subprocess. Plain TypeScript, zero dependencies.
 *
 * Responsibility is *only* JSON-RPC framing — line parsing, request-id
 * correlation, server-request dispatch. It has no knowledge of Codex
 * semantics (threads, turns, approvals); that lives in `CodexChatSession`.
 * This split keeps the client unit-testable against canned NDJSON.
 *
 * Wire notes (verified against codex-cli 0.132.0 — see
 * `test/fixtures/codex-app-server/SPIKE.md`):
 *  - Outbound requests/notifications carry `jsonrpc:"2.0"`.
 *  - Inbound responses OMIT `jsonrpc` — they are `{id,result}` or `{id,error}`.
 *    Correlation is purely by `id`.
 *  - Inbound server→client requests carry both `method` and `id`.
 *  - Inbound notifications carry `method` and no `id`.
 *
 * @module agents/codex/codex-app-server-client
 */

export type JsonRpcId = string | number

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface CodexAppServerClientOptions {
  /** Write one framed JSON line to the subprocess stdin (newline appended by the transport). */
  write: (line: string) => void
  /** Server→client notification (method, no id). */
  onNotification?: (method: string, params: unknown) => void
  /**
   * Server→client request (method + id). The handler must eventually call
   * `respond(id, ...)` or `respondError(id, ...)`. Codex approval prompts
   * arrive this way.
   */
  onServerRequest?: (method: string, params: unknown, id: JsonRpcId) => void
  /** Diagnostic hook for unparseable / malformed inbound lines. */
  onParseError?: (line: string, err: unknown) => void
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout | null
}

/** Error thrown when the server replies with a JSON-RPC `error` object. */
export class CodexRpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(err: JsonRpcError) {
    super(err.message)
    this.name = 'CodexRpcError'
    this.code = err.code
    this.data = err.data
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

export class CodexAppServerClient {
  private readonly opts: CodexAppServerClientOptions
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private disposed = false

  constructor(opts: CodexAppServerClientOptions) {
    this.opts = opts
  }

  /**
   * Issue a JSON-RPC request. Resolves with the `result` payload, rejects with
   * a `CodexRpcError` on a JSON-RPC error reply, or a plain `Error` on timeout
   * / disposal. `timeoutMs <= 0` disables the timeout.
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('CodexAppServerClient disposed'))
    const id = this.nextId++
    const envelope = JSON.stringify(
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params }
    )
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`Codex request '${method}' timed out after ${timeoutMs}ms`))
            }, timeoutMs)
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

  /** Reply to a server→client request with a success result. */
  respond(id: JsonRpcId, result: unknown): void {
    if (this.disposed) return
    this.opts.write(JSON.stringify({ jsonrpc: '2.0', id, result: result ?? null }))
  }

  /** Reply to a server→client request with an error. */
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
   * Feed one stdout line. Routes responses to pending requests, server
   * requests to `onServerRequest`, and notifications to `onNotification`.
   * Never throws — malformed input goes to `onParseError`.
   */
  handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: Record<string, unknown>
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null) {
        this.opts.onParseError?.(trimmed, new Error('non-object JSON-RPC message'))
        return
      }
      msg = parsed as Record<string, unknown>
    } catch (err) {
      this.opts.onParseError?.(trimmed, err)
      return
    }

    const hasId = msg.id !== undefined && msg.id !== null
    const isResponse = hasId && (('result' in msg) || ('error' in msg)) && !('method' in msg)

    if (isResponse) {
      this.resolvePending(msg.id as JsonRpcId, msg)
      return
    }

    if (typeof msg.method === 'string') {
      if (hasId) {
        // Server→client request.
        this.opts.onServerRequest?.(msg.method, msg.params, msg.id as JsonRpcId)
      } else {
        // Server→client notification.
        this.opts.onNotification?.(msg.method, msg.params)
      }
      return
    }

    this.opts.onParseError?.(trimmed, new Error('unrecognized JSON-RPC message shape'))
  }

  private resolvePending(id: JsonRpcId, msg: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if ('error' in msg && msg.error) {
      const e = msg.error as JsonRpcError
      pending.reject(new CodexRpcError(e))
    } else {
      pending.resolve(msg.result)
    }
  }

  /** Reject every pending request and stop accepting new ones. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error('Codex app-server connection closed'))
      this.pending.delete(id)
    }
  }
}
