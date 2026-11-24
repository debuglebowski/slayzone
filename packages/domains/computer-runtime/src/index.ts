/** Local, same-user control plane. Hub protocol versions never govern this link. */
import { connect, type Socket } from 'node:net'
import {
  COMPUTER_FRAME_MAX_BYTES,
  DuplexRpc,
  LineDecoder,
  RpcError,
  type FrameTooLargeInfo
} from '@slayzone/computer-transport/shared'

// v3 adds provider transitions and scoped draft/queue ownership preconditions.
// The hub protocol belongs to the replaceable connector and cannot prove that a
// retained v2 host enforces these payloads. v1/v2 remain explicitly unready until
// idle replacement, through inspection/stop controls only.
export const HOST_CONTRACT_VERSION = 3
/** v1/v2 can be bridged for inspecting/stopping work before an idle upgrade. */
export const HOST_MAINTENANCE_MIN_CONTRACT_VERSION = 1
export class ConnectorLease {
  private generation = 0
  claim(generation: number): boolean {
    if (!Number.isSafeInteger(generation) || generation <= this.generation) return false
    this.generation = generation
    return true
  }
  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
}

export interface RetryState {
  target: string
  attempts: number
  until: number
}
export class RetryPolicy {
  private target = ''
  private attempts = 0
  private until = 0
  constructor(
    private random: () => number = Math.random,
    state?: RetryState
  ) {
    if (
      state &&
      typeof state.target === 'string' &&
      Number.isSafeInteger(state.attempts) &&
      state.attempts >= 0 &&
      Number.isFinite(state.until)
    ) {
      this.target = state.target
      this.attempts = state.attempts
      this.until = state.until
    }
  }
  snapshot(): RetryState {
    return { target: this.target, attempts: this.attempts, until: this.until }
  }
  ready(target: string, now = Date.now()): boolean {
    return target !== this.target || now >= this.until
  }
  quarantine(target: string, now = Date.now()): number {
    this.target = target
    this.attempts = 3
    this.until = now + 900_000
    return 900_000
  }
  reset(): void {
    this.attempts = 0
    this.until = 0
  }
  fail(target: string, now = Date.now()): number {
    if (target !== this.target) {
      this.target = target
      this.attempts = 0
    }
    const n = ++this.attempts
    const delay =
      n >= 3
        ? 900_000
        : Math.round(Math.min(300_000, 5000 * 2 ** (n - 1)) * (0.8 + this.random() * 0.4))
    this.until = now + delay
    return delay
  }
}

/**
 * The local link relays hub traffic in envelopes: the connector sends the host
 * `dispatch { method, params, actor }` (hub → computer) and the host sends the
 * connector `upstream { method, params }` (computer → hub). For frame-limit errors
 * and diagnostics such a request is named by the hub method it carries, so the hub
 * caller reads `reply to 'chat.request'`, not `reply to 'dispatch'`.
 */
export function describeLocalRequest(method: string, params: unknown): string {
  if (method !== 'dispatch' && method !== 'upstream') return method
  const inner =
    params && typeof params === 'object' ? (params as { method?: unknown }).method : undefined
  return typeof inner === 'string' && inner.length > 0 ? inner : method
}

/**
 * Memory bound on what a local peer may fall behind by: two maximum frames, so the
 * largest legal reply always fits behind a full one, and never under 256 MiB.
 */
export function localWriteCeilingBytes(frameLimitBytes: number): number {
  return Math.max(256 * 1024 * 1024, 2 * frameLimitBytes)
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export interface LocalPeer {
  socket: Socket
  rpc: DuplexRpc
  close(): void
  /**
   * Why the link ended, once it has: which side closed it, or the frame/parse/
   * delivery fault that made this side drop it. Undefined while it is open. The
   * link's faults are otherwise silent — this is what makes a lost link diagnosable.
   */
  closeReason(): string | undefined
}
export function socketPeer(
  socket: Socket,
  handlers: {
    /**
     * Receive limit right now, in bytes (the host lowers it before authentication).
     * Default: `frameLimitBytes`.
     */
    maxFrameBytes?: () => number
    /**
     * The link's frame limit: outbound frames over it are refused (a reply becomes a
     * `frameTooLarge` error, a request is rejected locally) instead of the peer
     * destroying the socket. Default {@link COMPUTER_FRAME_MAX_BYTES} — this link
     * carries hub frames, so it shares their limit. Tests lower it.
     */
    frameLimitBytes?: number
    onFrameTooLarge?: (info: FrameTooLargeInfo) => void
    request?: (
      method: string,
      params: unknown,
      actor: unknown,
      signal: AbortSignal
    ) => unknown | Promise<unknown>
    notify?: (method: string, params: unknown) => void
    /**
     * Outbound bytes that may sit queued before the link is dropped — the memory
     * bound. Default {@link localWriteCeilingBytes}.
     */
    writeCeilingBytes?: number
  } = {}
): LocalPeer {
  const decoder = new LineDecoder()
  const frameLimit = handlers.frameLimitBytes ?? COMPUTER_FRAME_MAX_BYTES
  const ceiling = handlers.writeCeilingBytes ?? localWriteCeilingBytes(frameLimit)
  /** UTF-8 bytes of the frame being received (the decoder's unterminated tail). */
  let bytes = 0
  let closeReason: string | undefined
  /** End the link from this side; the first reason recorded is the one reported. */
  const drop = (reason: string): void => {
    closeReason ??= reason
    // Settle at once, not on the socket's later 'close': writes after this are
    // no-ops (notify) or rejected (request) instead of throwing into callers.
    rpc.dispose(`local link dropped: ${reason}`)
    socket.destroy()
  }
  const rpc = new DuplexRpc({
    label: 'computer-local',
    maxFrameBytes: frameLimit,
    describeRequest: describeLocalRequest,
    ...(handlers.onFrameTooLarge ? { onFrameTooLarge: handlers.onFrameTooLarge } : {}),
    // Never refuses a frame for being behind: a refused frame is lost mid-stream (a
    // refused reply used to tear the whole link down under chat streaming). A busy
    // reader's backlog is just queued; the link is dropped only when the backlog
    // passes the memory ceiling. A hung peer is caught there or by the hub's own
    // liveness checks — Node flushes the backlog as one batch, so the socket cannot
    // tell a slow reader from a stopped one any sooner.
    write: (line) => {
      if (socket.destroyed || !socket.writable)
        throw new Error(`local link closed${closeReason ? ` (${closeReason})` : ''}`)
      if (!socket.write(line + '\n') && socket.writableLength > ceiling)
        drop(
          `peer not reading fast enough: ${mib(socket.writableLength)} queued over the ${mib(ceiling)} ceiling`
        )
    },
    onPeerRequest: (method, params, id, actor, signal) => {
      void Promise.resolve()
        .then(() => {
          if (!handlers.request) throw new Error('local method unavailable')
          return handlers.request(method, params, actor, signal)
        })
        .then(
          (result) => rpc.respond(id, result),
          // Relayed whole: `data` carries the structured part of an answer (an fs
          // errno, a refusal's detail) that the hub maps on — dropping it here made
          // a missing file on a remote computer read as a server error.
          (err) =>
            err instanceof RpcError
              ? rpc.respondError(id, err.code, err.message, err.data)
              : rpc.respondError(
                  id,
                  -32000,
                  err instanceof Error ? err.message : 'local request failed'
                )
        )
        // Only a link that is already gone refuses a reply now (see `write`).
        .catch((err: unknown) => {
          drop(
            `response to ${method} could not be delivered: ${err instanceof Error ? err.message : String(err)}`
          )
        })
    },
    onNotification: handlers.notify,
    onParseError: () => drop('received an unparseable frame')
  })
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    const limit = handlers.maxFrameBytes?.() ?? frameLimit
    const lines = decoder.feed(chunk)
    // A frame is one line WITHOUT its '\n' framing. Completed lines are measured
    // whole (a UTF-16 unit is at most 3 UTF-8 bytes, so short ones skip the scan);
    // the unterminated tail is tracked incrementally.
    for (const line of lines) {
      if (line.length * 3 > limit && Buffer.byteLength(line) > limit) {
        drop(`received a frame over the ${limit}-byte limit`)
        return
      }
    }
    bytes = lines.length ? Buffer.byteLength(decoder.partial) : bytes + Buffer.byteLength(chunk)
    if (bytes > limit) {
      drop(`received an unterminated frame over the ${limit}-byte limit`)
      return
    }
    for (const line of lines) rpc.handleLine(line)
  })
  socket.on('close', () => {
    closeReason ??= 'closed by the peer'
    rpc.dispose('local connection closed')
  })
  socket.on('error', (err) => {
    closeReason ??= `socket error: ${err.message}`
    rpc.dispose('local connection failed')
  })
  return {
    socket,
    rpc,
    close: () => drop('closed by this side'),
    closeReason: () => closeReason
  }
}
export async function connectLocal(
  endpoint: string,
  handlers?: Parameters<typeof socketPeer>[1]
): Promise<LocalPeer> {
  const socket = connect(endpoint)
  const peer = socketPeer(socket, handlers)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('session host connect timed out'))
    }, 5000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  return peer
}
