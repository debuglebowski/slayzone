/**
 * The computer's side of the direct protocol over a data channel: the channel looks
 * like a `ws` socket to tRPC's connection handler (docs/direct-link.md).
 */
import { describe, expect, it } from 'vitest'
import {
  channelWebSocket,
  DIRECT_RTC_PIECE_CHARS
} from '../../../../shared/transport/src/direct/rtc-channel'
import { fakeChannelPair } from '../../../../shared/transport/src/direct/rtc-channel-fake'
import { RtcServerSocket } from './rtc-socket'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('RtcServerSocket', () => {
  it('delivers whole messages as text Buffers, and sends large ones in pieces', async () => {
    const [client, server] = fakeChannelPair()
    const socket = new RtcServerSocket(server, { maxMessageChars: 2 << 20 })
    const WS = channelWebSocket(client, { maxMessageChars: 2 << 20 })
    const ws = new WS('rtc://x')
    const received: Array<{ data: Buffer; isBinary: boolean }> = []
    socket.on('message', (data: Buffer, isBinary: boolean) => received.push({ data, isBinary }))
    const back: string[] = []
    ws.addEventListener('message', ((e: { data: string }) => back.push(e.data)) as never)
    client.open()
    server.open()
    expect(socket.readyState).toBe(1)
    const big = 'b'.repeat(1 << 20)
    ws.send(big)
    await tick()
    expect(received.length).toBe(1)
    expect(Buffer.isBuffer(received[0]?.data)).toBe(true)
    expect(received[0]?.isBinary).toBe(false)
    expect(received[0]?.data.toString()).toBe(big)
    socket.send(big)
    await tick()
    expect(back).toEqual([big])
    expect(server.pieces.every((p) => p.length <= DIRECT_RTC_PIECE_CHARS + 1)).toBe(true)
  })

  it('closes on an oversize or malformed message, and reports close once', async () => {
    const [client, server] = fakeChannelPair()
    const socket = new RtcServerSocket(server, { maxMessageChars: 100 })
    let closes = 0
    socket.on('close', () => closes++)
    client.open()
    server.open()
    client.send('+' + 'x'.repeat(200))
    await tick()
    expect(socket.readyState).toBe(3)
    expect(closes).toBe(1)
    socket.terminate()
    expect(closes).toBe(1)
  })

  it('a peer closing the channel closes the socket', async () => {
    const [client, server] = fakeChannelPair()
    const socket = new RtcServerSocket(server, { maxMessageChars: 100 })
    const closed = new Promise((r) => socket.once('close', r))
    client.open()
    server.open()
    client.close()
    await closed
    expect(socket.readyState).toBe(3)
  })
})
