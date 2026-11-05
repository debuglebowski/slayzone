/**
 * The client's WebRTC connect (docs/direct-link.md): offer with every candidate
 * gathered, the hub brokers it, the answer is applied, and the data channel becomes
 * the direct socket — or the attempt fails cleanly within its deadline.
 */
import { describe, expect, it, vi } from 'vitest'
import { DIRECT_RTC_LABEL } from '../direct/rtc-channel'
import { FakeChannel } from '../direct/rtc-channel-fake'
import { openDirectRtcConnection } from './direct-rtc'

class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'new'
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: { type: string; sdp: string } | null = null
  remote: { type: string; sdp: string } | null = null
  channel = new FakeChannel()
  label = ''
  closed = false
  constructor(readonly config: RTCConfiguration) {
    super()
  }
  createDataChannel(label: string) {
    this.label = label
    return this.channel
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' }
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = { ...d, sdp: `${d.sdp}+candidates` }
    setTimeout(() => {
      this.iceGatheringState = 'complete'
      this.dispatchEvent(new Event('icegatheringstatechange'))
    }, 5)
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d
  }
  close() {
    this.closed = true
  }
  /** The selected pair's local candidate type (null: no stats). */
  route: string | null = null
  async getStats() {
    const stats = new Map<string, Record<string, unknown>>()
    if (this.route === null) return stats
    stats.set('pair', {
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'local'
    })
    stats.set('local', { type: 'local-candidate', candidateType: this.route })
    return stats
  }
}

describe('openDirectRtcConnection', () => {
  it('offers with candidates, applies the brokered answer, and opens on the channel', async () => {
    const peers: FakePeer[] = []
    const connect = vi.fn(async () => {
      // The computer accepted: the channel opens once DTLS/SCTP are up.
      setTimeout(() => peers[0]?.channel.open(), 5)
      return { ok: true as const, sdp: 'answer-sdp' }
    })
    const conn = await openDirectRtcConnection({
      createPeer: (config) => {
        const p = new FakePeer(config)
        peers.push(p)
        return p as unknown as RTCPeerConnection
      },
      stunAddresses: ['stun.cloudflare.com:3478'],
      grantId: 'g1',
      token: 't'.repeat(43),
      connect
    })
    expect(peers[0]?.config).toEqual({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })
    expect(peers[0]?.label).toBe(DIRECT_RTC_LABEL)
    expect(connect).toHaveBeenCalledWith('g1', 'offer-sdp+candidates')
    expect(peers[0]?.remote).toEqual({ type: 'answer', sdp: 'answer-sdp' })
    let closed = false
    conn.onClose(() => {
      closed = true
    })
    conn.close()
    expect(closed).toBe(true)
    expect(peers[0]?.closed).toBe(true)
  })

  it('fails, closing the peer, when the hub brokers no answer', async () => {
    const peer = new FakePeer({})
    await expect(
      openDirectRtcConnection({
        createPeer: () => peer as unknown as RTCPeerConnection,
        stunAddresses: [],
        grantId: 'g1',
        token: 't',
        connect: async () => ({ ok: false as const, reason: 'refused' })
      })
    ).rejects.toThrow(/refused/)
    expect(peer.closed).toBe(true)
  })

  it('fails within its deadline when the channel never opens (ICE failed)', async () => {
    const peer = new FakePeer({})
    const started = Date.now()
    await expect(
      openDirectRtcConnection({
        createPeer: () => peer as unknown as RTCPeerConnection,
        stunAddresses: [],
        grantId: 'g1',
        token: 't',
        connect: async () => ({ ok: true as const, sdp: 'answer' }),
        connectMs: 100
      })
    ).rejects.toThrow(/did not connect/)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(peer.closed).toBe(true)
  })
})

describe('which route the channel took', () => {
  for (const [candidateType, route] of [
    ['host', 'local'],
    ['srflx', 'stun'],
    ['prflx', 'stun']
  ] as const) {
    it(`reports a ${candidateType} pair as ${route}`, async () => {
      const peer = new FakePeer({})
      peer.route = candidateType
      const conn = await openDirectRtcConnection({
        createPeer: () => peer as unknown as RTCPeerConnection,
        stunAddresses: [],
        grantId: 'g1',
        token: 't',
        connect: async () => {
          setTimeout(() => peer.channel.open(), 5)
          return { ok: true as const, sdp: 'answer' }
        }
      })
      expect(conn.route).toBe(route)
      conn.close()
    })
  }
})
