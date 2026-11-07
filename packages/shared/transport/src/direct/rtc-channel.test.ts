/**
 * The direct protocol over a WebRTC data channel (docs/direct-link.md): messages are
 * split into pieces small enough for every SCTP stack and rejoined in order, and the
 * client side looks like a WebSocket to tRPC's ws client.
 */
import { describe, expect, it } from 'vitest'
import {
  DIRECT_RTC_PIECE_CHARS,
  channelWebSocket,
  createReassembler,
  splitMessage
} from './rtc-channel'
import { fakeChannelPair } from './rtc-channel-fake'

describe('framing', () => {
  it('splits a message into small pieces and rejoins it exactly', () => {
    const big = 'é'.repeat(3 * DIRECT_RTC_PIECE_CHARS + 17)
    const pieces = splitMessage(big)
    expect(pieces.length).toBe(4)
    expect(pieces.every((p) => p.length <= DIRECT_RTC_PIECE_CHARS + 1)).toBe(true)
    const r = createReassembler(1 << 20)
    const out = pieces.map((p) => r.feed(p))
    expect(out.slice(0, 3)).toEqual([null, null, null])
    expect(out[3]).toBe(big)
    expect(createReassembler(10).feed(splitMessage('short')[0]!)).toBe('short')
  })

  it('refuses a message past the size limit (a flood is not buffered)', () => {
    const r = createReassembler(DIRECT_RTC_PIECE_CHARS + 10)
    const pieces = splitMessage('x'.repeat(DIRECT_RTC_PIECE_CHARS * 3))
    expect(r.feed(pieces[0]!)).toBeNull()
    expect(() => r.feed(pieces[1]!)).toThrow(/too large/)
  })

  it('refuses a piece without a valid marker', () => {
    expect(() => createReassembler(100).feed('?abc')).toThrow(/malformed/)
  })
})

describe('channelWebSocket (client side, for tRPC)', () => {
  it('is a WebSocket over the channel: open, 1 MiB both ways, close', async () => {
    const [mine, theirs] = fakeChannelPair()
    const WS = channelWebSocket(mine, { maxMessageChars: 2 << 20 })
    const ws = new WS('rtc://unused')
    const events: string[] = []
    ws.addEventListener('open', () => events.push('open'))
    const received: string[] = []
    ws.addEventListener('message', (e: MessageEvent) => received.push(String(e.data)))
    ws.addEventListener('close', () => events.push('close'))
    expect(ws.readyState).toBe(WS.CONNECTING)
    mine.open()
    theirs.open()
    expect(ws.readyState).toBe(WS.OPEN)
    const big = 'a'.repeat(1 << 20)
    ws.send(big)
    await new Promise((r) => setTimeout(r, 0))
    const back = createReassembler(2 << 20)
    let got: string | null = null
    for (const p of theirs.peer!.pieces) got = back.feed(p) ?? got
    expect(got).toBe(big)
    for (const p of splitMessage('{"id":1}')) theirs.send(p)
    await new Promise((r) => setTimeout(r, 0))
    expect(received).toEqual(['{"id":1}'])
    ws.close()
    expect(ws.readyState).toBe(WS.CLOSED)
    expect(events).toEqual(['open', 'close'])
    expect(theirs.readyState).toBe('closed')
  })

  it('opens at once on a channel that is already open', async () => {
    const [mine] = fakeChannelPair()
    mine.open()
    const WS = channelWebSocket(mine, { maxMessageChars: 1000 })
    const ws = new WS('rtc://unused')
    const opened = new Promise((r) => ws.addEventListener('open', r))
    await opened
    expect(ws.readyState).toBe(WS.OPEN)
  })
})
