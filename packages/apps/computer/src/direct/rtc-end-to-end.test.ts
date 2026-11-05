/**
 * The whole WebRTC direct link (docs/direct-link.md), every side real except the
 * hub: the client's direct-link manager (node-datachannel standing in for the
 * renderer's RTCPeerConnection) asks a fake hub that registers the grant on the
 * computer and brokers the offer to the computer's answerer; the data channel is
 * served by the computer's direct listener.
 */
import { createHash, randomBytes } from 'node:crypto'
import { DIRECT_RTC_CHANNEL_LABEL } from '@slayzone/computer-transport/shared'
import { afterEach, expect, it } from 'vitest'
import { DIRECT_RTC_LABEL } from '../../../../shared/transport/src/direct/rtc-channel'
import { createDirectLinkManager } from '../../../../shared/transport/src/client/direct-link'
import { createDirectGrantStore } from './grants'
import { createDirectListener } from './listener'
import { createRtcAnswerer } from './rtc-answerer'
import { loadRtcPolyfill } from './rtc-runtime'

const rtc = loadRtcPolyfill()!
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

it('the client and the computer name the same data channel', () => {
  expect(DIRECT_RTC_LABEL).toBe(DIRECT_RTC_CHANNEL_LABEL)
})

it('a client reaches a terminal over WebRTC, brokered by the hub, and types into it', async () => {
  const grants = createDirectGrantStore()
  const writes: string[] = []
  const listener = await createDirectListener({
    grants,
    listenAddress: '127.0.0.1:0',
    log: () => undefined,
    services: {
      pty: () =>
        ({
          attach: (sessionId: string, afterSeq: number) => ({
            exists: true,
            size: null,
            buffer: { chunks: [{ seq: 0, data: 'hello' }], prelude: '', currentSeq: 0, afterSeq }
          }),
          write: (sessionId: string, data: string) => {
            writes.push(`${sessionId}:${data}`)
            return true
          },
          getBufferSince: () => ({ chunks: [], prelude: '', currentSeq: 0 }),
          watch: () => () => undefined
        }) as never,
      chat: () => null
    }
  })
  const answerer = createRtcAnswerer({ rtc, grants, listener, log: () => undefined })
  cleanups.push(
    () => grants.close(),
    () => listener.close(),
    () => answerer.close()
  )
  // The hub: registers the grant's hash on the computer, then brokers the offer.
  const manager = createDirectLinkManager({
    issue: async (target) => {
      const token = randomBytes(32).toString('base64url')
      const grantId = `g-${randomBytes(4).toString('hex')}`
      grants.grant('hub', {
        grantId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        userId: null,
        resource: { kind: 'pty', sessionId: (target as { sessionId: string }).sessionId },
        ttlMs: 60_000
      })
      return {
        available: true,
        transport: 'webrtc',
        computerId: 'c1',
        token,
        grantId,
        expiresInMs: 60_000,
        protocol: 1,
        stunAddresses: []
      }
    },
    rtc: {
      createPeer: (config) => new rtc.RTCPeerConnection(config) as unknown as RTCPeerConnection,
      connect: async (grantId, sdp) => {
        const answer = await answerer.answer('hub', {
          grantId,
          sdp,
          stunAddresses: [],
          clientAddress: '198.51.100.7'
        })
        return { ok: true, sdp: answer.sdp }
      }
    }
  })
  cleanups.push(() => manager.dispose())
  const lease = await manager.acquire({ kind: 'pty', sessionId: 's1', taskId: 't1' })
  expect(lease).not.toBeNull()
  const attached = await lease!.client.pty.attach.query({ sessionId: 's1', afterSeq: -1 })
  expect(attached.buffer.chunks.map((c) => c.data)).toEqual(['hello'])
  expect(await lease!.client.pty.write.mutate({ sessionId: 's1', data: 'ls\r' })).toBe(true)
  expect(writes).toEqual(['s1:ls\r'])
  // A second session rides the same peer connection, authorized on it.
  const second = await manager.acquire({ kind: 'pty', sessionId: 's2', taskId: 't1' })
  expect(second?.client).toBe(lease?.client)
  expect(answerer.size()).toBe(1)
  expect(manager.status()).toEqual([
    {
      computerId: 'c1',
      path: 'direct',
      transport: 'webrtc',
      address: null,
      route: 'local',
      leases: 2
    }
  ])
}, 20_000)
