/**
 * The direct protocol over a WebRTC data channel (docs/direct-link.md).
 *
 * The channel carries exactly what the computer's WebSocket listener carries (tRPC
 * messages, the capability in the first one, PING/PONG), so terminals and chat run
 * one code path whichever transport reached the computer. Two things differ:
 *
 *  - SCTP stacks cap a message (some at 64 KiB, Chrome at 256 KiB) while a backfill
 *    can be larger. Every message is split into pieces of at most
 *    {@link DIRECT_RTC_PIECE_CHARS} characters, each marked `+` (more follow) or `.`
 *    (last), and rejoined on the other side. The channel is ordered and reliable,
 *    so pieces arrive in order. A message past the receiver's limit is refused
 *    rather than buffered.
 *  - tRPC's ws client wants a WebSocket class: {@link channelWebSocket} makes one
 *    over an open (or opening) channel.
 *
 * Pure: no DOM, no Node. The renderer, React Native and the computer all import it
 * (events are plain objects: React Native has no Event constructors).
 *
 * @module transport/direct/rtc-channel
 */

/**
 * Characters per piece. A character is at most 3 UTF-8 bytes here (JSON text; a
 * surrogate pair is 2 characters for 4 bytes), so a piece stays under 48 KiB, below
 * every stack's message limit.
 */
export const DIRECT_RTC_PIECE_CHARS = 16_000

const MORE = '+'
const LAST = '.'

/** What both a browser `RTCDataChannel` and node-datachannel's polyfill provide. */
export interface RtcChannelLike {
  readonly readyState: RTCDataChannelState
  readonly bufferedAmount: number
  send(data: string): void
  close(): void
  onopen: ((ev: Event) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onclose: ((ev: Event) => void) | null
  onerror: ((ev: RTCErrorEvent) => void) | null
}

/** One message as the pieces to send, in order. */
export function splitMessage(message: string): string[] {
  if (message.length <= DIRECT_RTC_PIECE_CHARS) return [LAST + message]
  const pieces: string[] = []
  let at = 0
  while (at < message.length) {
    let end = Math.min(at + DIRECT_RTC_PIECE_CHARS, message.length)
    // Never split a surrogate pair across pieces.
    const code = message.charCodeAt(end - 1)
    if (end < message.length && code >= 0xd800 && code <= 0xdbff) end--
    pieces.push((end >= message.length ? LAST : MORE) + message.slice(at, end))
    at = end
  }
  return pieces
}

export interface Reassembler {
  /** The whole message once its last piece arrived, else null. Throws on a bad piece. */
  feed(piece: string): string | null
}

/** Rejoins pieces; refuses a message longer than `maxMessageChars`. */
export function createReassembler(maxMessageChars: number): Reassembler {
  let parts: string[] = []
  let size = 0
  return {
    feed(piece) {
      const mark = piece[0]
      if (mark !== MORE && mark !== LAST) throw new Error('malformed direct-link piece')
      size += piece.length - 1
      if (size > maxMessageChars) {
        parts = []
        size = 0
        throw new Error('direct-link message too large')
      }
      parts.push(piece.slice(1))
      if (mark === MORE) return null
      const whole = parts.join('')
      parts = []
      size = 0
      return whole
    }
  }
}

type Listener = (ev: never) => void

/** The fields of an event tRPC's ws client reads. */
interface PlainEvent {
  type: string
  data?: string
  code?: number
}

/** The WebSocket class tRPC's `createWSClient({ WebSocket })` constructs. */
export interface ChannelWebSocketClass {
  new (url: string): ChannelWebSocket
  readonly CONNECTING: 0
  readonly OPEN: 1
  readonly CLOSING: 2
  readonly CLOSED: 3
}

export interface ChannelWebSocket {
  readonly readyState: number
  binaryType: string
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, cb: Listener): void
  removeEventListener(type: string, cb: Listener): void
}

/**
 * A WebSocket class over one data channel, for tRPC's ws client. The url is
 * ignored: the channel is already chosen. Constructed once per channel — the
 * direct-link manager never lets tRPC reconnect on its own.
 */
export function channelWebSocket(
  channel: RtcChannelLike,
  opts: { maxMessageChars: number }
): ChannelWebSocketClass {
  class Socket implements ChannelWebSocket {
    static readonly CONNECTING = 0 as const
    static readonly OPEN = 1 as const
    static readonly CLOSING = 2 as const
    static readonly CLOSED = 3 as const
    binaryType = 'arraybuffer'
    private closed = false
    private readonly listeners = new Map<string, Set<Listener>>()
    private readonly reassembler = createReassembler(opts.maxMessageChars)

    constructor(_url: string) {
      channel.onopen = () => this.emit({ type: 'open' })
      channel.onmessage = (ev) => {
        let whole: string | null
        try {
          whole = this.reassembler.feed(String(ev.data))
        } catch {
          this.close()
          return
        }
        if (whole !== null) this.emit({ type: 'message', data: whole })
      }
      channel.onclose = () => this.finish()
      channel.onerror = () => this.emit({ type: 'error' })
      if (channel.readyState === 'open') {
        // A macrotask, not a microtask: tRPC constructs the socket and attaches its
        // listeners in separate promise steps, and a microtask would fire between them.
        setTimeout(() => {
          if (!this.closed) this.emit({ type: 'open' })
        }, 0)
      }
    }

    get readyState(): number {
      if (this.closed) return Socket.CLOSED
      switch (channel.readyState) {
        case 'connecting':
          return Socket.CONNECTING
        case 'open':
          return Socket.OPEN
        case 'closing':
          return Socket.CLOSING
        default:
          return Socket.CLOSED
      }
    }

    send(data: string): void {
      for (const piece of splitMessage(String(data))) channel.send(piece)
    }

    close(): void {
      channel.close()
      this.finish()
    }

    addEventListener(type: string, cb: Listener): void {
      let set = this.listeners.get(type)
      if (!set) this.listeners.set(type, (set = new Set()))
      set.add(cb)
    }

    removeEventListener(type: string, cb: Listener): void {
      this.listeners.get(type)?.delete(cb)
    }

    private finish(): void {
      if (this.closed) return
      this.closed = true
      this.emit({ type: 'close', code: 1000 })
    }

    private emit(ev: PlainEvent): void {
      for (const cb of [...(this.listeners.get(ev.type) ?? [])]) (cb as (e: PlainEvent) => void)(ev)
    }
  }
  return Socket
}
