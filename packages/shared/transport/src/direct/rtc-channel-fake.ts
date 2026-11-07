/**
 * Test-only: two in-memory data-channel ends for the direct protocol's WebRTC
 * adapters. Not exported from any barrel; tests import it by path.
 */
import { DIRECT_RTC_PIECE_CHARS, type RtcChannelLike } from './rtc-channel'

/** Two in-memory channel ends: what one sends, the other receives (in order). */
export function fakeChannelPair(): [FakeChannel, FakeChannel] {
  const a = new FakeChannel()
  const b = new FakeChannel()
  a.peer = b
  b.peer = a
  return [a, b]
}

export class FakeChannel implements RtcChannelLike {
  readyState: RTCDataChannelState = 'connecting'
  bufferedAmount = 0
  peer: FakeChannel | null = null
  pieces: string[] = []
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: Event) => void) | null = null
  onerror: ((ev: RTCErrorEvent) => void) | null = null
  open(): void {
    this.readyState = 'open'
    this.onopen?.(new Event('open'))
  }
  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('not open')
    if (data.length > DIRECT_RTC_PIECE_CHARS + 1) throw new Error('piece too large for SCTP')
    this.pieces.push(data)
    const peer = this.peer
    queueMicrotask(() => peer?.onmessage?.(new MessageEvent('message', { data })))
  }
  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.(new Event('close'))
    this.peer?.close()
  }
}
