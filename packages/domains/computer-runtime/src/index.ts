/** Local, same-user control plane. Hub protocol versions never govern this link. */
import { connect, type Socket } from 'node:net'
import { DuplexRpc, LineDecoder, RpcError } from '@slayzone/computer-transport/shared'

// v3 adds provider transitions and scoped draft/queue ownership preconditions.
// The hub protocol belongs to the replaceable connector and cannot prove that a
// retained v2 host enforces these payloads. v1/v2 remain explicitly unready until
// idle replacement, through inspection/stop controls only.
export const HOST_CONTRACT_VERSION = 3
/** v1/v2 can be bridged for inspecting/stopping work before an idle upgrade. */
export const HOST_MAINTENANCE_MIN_CONTRACT_VERSION = 1
/** Computer-owned chat stop/clear first existed in host v2. */
export const HOST_CHAT_STOP_MIN_CONTRACT_VERSION = 2
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

export interface LocalPeer {
  socket: Socket
  rpc: DuplexRpc
  close(): void
}
export function socketPeer(
  socket: Socket,
  handlers: {
    maxFrameBytes?: () => number
    request?: (method: string, params: unknown, actor: unknown) => unknown | Promise<unknown>
    notify?: (method: string, params: unknown) => void
  } = {}
): LocalPeer {
  const decoder = new LineDecoder()
  let bytes = 0
  const rpc = new DuplexRpc({
    label: 'computer-local',
    write: (line) => {
      if (socket.destroyed || socket.writableLength > 8 * 1024 * 1024)
        throw new Error('local connector unavailable or backpressured')
      socket.write(line + '\n')
    },
    onPeerRequest: (method, params, id, actor) => {
      void Promise.resolve()
        .then(() => {
          if (!handlers.request) throw new Error('local method unavailable')
          return handlers.request(method, params, actor)
        })
        .then(
          (result) => rpc.respond(id, result),
          (err) =>
            rpc.respondError(
              id,
              err instanceof RpcError ? err.code : -32000,
              err instanceof Error ? err.message : 'local request failed'
            )
        )
        .catch(() => {
          rpc.dispose('local response could not be delivered')
          socket.destroy()
        })
    },
    onNotification: handlers.notify,
    onParseError: () => socket.destroy()
  })
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > (handlers.maxFrameBytes?.() ?? 100 * 1024 * 1024)) {
      socket.destroy()
      return
    }
    const lines = decoder.feed(chunk)
    if (lines.length) bytes = 0
    for (const line of lines) rpc.handleLine(line)
  })
  socket.on('close', () => rpc.dispose('local connection closed'))
  socket.on('error', () => rpc.dispose('local connection failed'))
  return { socket, rpc, close: () => socket.destroy() }
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
