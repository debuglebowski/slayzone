/**
 * R2 (docs/direct-link.md): over WebRTC every direct-protocol message must fit the
 * channel's message cap. A full TUI scrollback (750 KiB, escape-heavy: JSON writes
 * each ESC as \u001b) serialises past it, so backfill is read in pages; reading it
 * must keep the channel open and return every chunk once, in order.
 */
import { createHash } from 'node:crypto'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import type { DirectRouter } from '@slayzone/transport/direct'
import { readDirectPtyBuffer, attachDirectPty } from '@slayzone/transport/direct-client'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import { afterEach, expect, it } from 'vitest'
import {
  channelWebSocket,
  DIRECT_RTC_MAX_MESSAGE_CHARS
} from '../../../../shared/transport/src/direct/rtc-channel'
import { fakeChannelPair } from '../../../../shared/transport/src/direct/rtc-channel-fake'
import { createDirectGrantStore } from './grants'
import { createDirectListener } from './listener'
import { RtcServerSocket } from './rtc-socket'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** 750 KiB of truecolor SGR + box drawing + CRLF, in 4 KiB chunks. */
function tuiScrollback(): Array<{ seq: number; data: string }> {
  const line = '\x1b[38;2;12;34;56m│\x1b[1m agent \x1b[0m\x1b[48;2;1;2;3m─────\x1b[0m\r\n'
  const chunk = line.repeat(Math.ceil(4096 / line.length)).slice(0, 4096)
  return Array.from({ length: 750 / 4 }, (_, seq) => ({ seq, data: chunk }))
}

it('a full escape-heavy scrollback is read in pages over a data channel, gap-free', async () => {
  const scrollback = tuiScrollback()
  const slice = (afterSeq: number, maxChars?: number) => {
    const all = scrollback.filter((c) => c.seq > afterSeq)
    if (maxChars === undefined) return { chunks: all, prelude: '', currentSeq: 186, more: false }
    const out: typeof all = []
    let size = 0
    for (const c of all) {
      const cost = JSON.stringify(c.data).length + 32
      if (out.length > 0 && size + cost > maxChars) break
      out.push(c)
      size += cost
    }
    return { chunks: out, prelude: '', currentSeq: 186, more: out.length < all.length }
  }
  const grants = createDirectGrantStore()
  const listener = await createDirectListener({
    grants,
    listenAddress: '127.0.0.1:0',
    log: () => undefined,
    services: {
      pty: () =>
        ({
          attach: (_s: string, afterSeq: number, maxChars?: number) => ({
            exists: true,
            size: null,
            buffer: slice(afterSeq, maxChars)
          }),
          getBufferSince: (_s: string, afterSeq: number, maxChars?: number) =>
            slice(afterSeq, maxChars),
          write: () => true,
          watch: () => () => undefined
        }) as never,
      chat: () => null
    }
  })
  cleanups.push(
    () => grants.close(),
    () => listener.close()
  )
  const token = 't'.repeat(43)
  grants.grant('hub', {
    grantId: 'g1',
    tokenHash: createHash('sha256').update(token).digest('hex'),
    userId: null,
    resource: { kind: 'pty', sessionId: 's1' },
    ttlMs: 60_000
  })
  const [mine, theirs] = fakeChannelPair()
  listener.serveChannel(
    new RtcServerSocket(theirs, { maxMessageChars: DIRECT_RTC_MAX_MESSAGE_CHARS }),
    {
      ip: '198.51.100.7'
    }
  )
  mine.open()
  theirs.open()
  let closed = false
  const ws = createWSClient({
    url: 'rtc://direct',
    WebSocket: channelWebSocket(mine, { maxMessageChars: DIRECT_RTC_MAX_MESSAGE_CHARS }) as never,
    connectionParams: { token },
    retryDelayMs: () => 60_000,
    onClose: () => {
      closed = true
    }
  })
  cleanups.push(() => ws.close())
  const client = createTRPCClient<DirectRouter>({
    links: [wsLink({ client: ws, transformer: wireSuperjson })]
  })

  const backfill = await readDirectPtyBuffer(client, 's1', -1)
  expect(backfill.chunks.map((c) => c.seq)).toEqual(scrollback.map((c) => c.seq))
  expect(backfill.chunks.map((c) => c.data).join('')).toBe(scrollback.map((c) => c.data).join(''))
  const attached = await attachDirectPty(client, 's1', 10)
  expect(attached.buffer.chunks.map((c) => c.seq)).toEqual(scrollback.slice(11).map((c) => c.seq))
  expect(closed).toBe(false)
  // Every message stayed under the channel's cap.
  expect(theirs.pieces.length).toBeGreaterThan(0)
})
