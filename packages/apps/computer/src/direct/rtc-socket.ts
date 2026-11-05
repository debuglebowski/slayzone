/**
 * A WebRTC data channel as tRPC's ws connection handler sees a socket
 * (docs/direct-link.md): `on('message', (Buffer, isBinary))`, `send`, `close`,
 * `terminate`, `readyState`. Messages are split and rejoined by the shared framing
 * (`@slayzone/transport/direct` rtc-channel), so the listener serves a data channel
 * exactly as it serves a WebSocket.
 *
 * @module computer/direct/rtc-socket
 */
import { EventEmitter } from 'node:events'
import { createReassembler, splitMessage, type RtcChannelLike } from '@slayzone/transport/direct'

const OPEN = 1
const CLOSED = 3

export class RtcServerSocket extends EventEmitter {
  private closed = false
  private readonly reassembler: ReturnType<typeof createReassembler>

  constructor(
    private readonly channel: RtcChannelLike,
    opts: { maxMessageChars: number }
  ) {
    super()
    this.reassembler = createReassembler(opts.maxMessageChars)
    channel.onmessage = (ev) => {
      let whole: string | null
      try {
        whole = this.reassembler.feed(String(ev.data))
      } catch (err) {
        this.close(1009, 'message too large')
        this.report(err)
        return
      }
      // tRPC's handler wants a Buffer flagged as text, as `ws` delivers one.
      if (whole !== null) this.emit('message', Buffer.from(whole), false)
    }
    channel.onclose = () => this.finish()
    channel.onerror = () => this.report(new Error('data channel error'))
  }

  /** `ws` numbering: 0 connecting, 1 open, 2 closing, 3 closed. */
  get readyState(): number {
    if (this.closed) return CLOSED
    switch (this.channel.readyState) {
      case 'connecting':
        return 0
      case 'open':
        return OPEN
      case 'closing':
        return 2
      default:
        return CLOSED
    }
  }

  readonly OPEN = OPEN

  send(data: string | Buffer): void {
    if (this.readyState !== OPEN) return
    for (const piece of splitMessage(data.toString())) this.channel.send(piece)
  }

  close(_code?: number, _reason?: string): void {
    this.channel.close()
    this.finish()
  }

  terminate(): void {
    this.close()
  }

  /** An `error` event only when someone listens (tRPC's handler does): never a throw. */
  private report(err: unknown): void {
    if (this.listenerCount('error') > 0) this.emit('error', err)
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', 1000, Buffer.alloc(0))
  }
}
