/**
 * The computer answers a client's WebRTC offer for a grant its hub registered, and
 * serves the resulting data channel through the direct listener (docs/direct-link.md).
 * The "client" here is node-datachannel's own RTCPeerConnection.
 */
import { createHash } from 'node:crypto'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import { DIRECT_RTC_CHANNEL_LABEL } from '@slayzone/computer-transport/shared'
import type { DirectRouter } from '@slayzone/transport/direct'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import { afterEach, describe, expect, it } from 'vitest'
import { channelWebSocket } from '../../../../shared/transport/src/direct/rtc-channel'
import { createDirectGrantStore } from './grants'
import { createDirectListener } from './listener'
import { createRtcAnswerer } from './rtc-answerer'
import { loadRtcPolyfill } from './rtc-runtime'

const rtc = loadRtcPolyfill()!
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

let n = 0
async function setup(limits?: Parameters<typeof createRtcAnswerer>[0]['limits']) {
  const grants = createDirectGrantStore()
  const listener = await createDirectListener({
    grants,
    listenAddress: '127.0.0.1:0',
    log: () => undefined,
    services: {
      pty: () => null,
      chat: () => null
    }
  })
  const answerer = createRtcAnswerer({ rtc, grants, listener, log: () => undefined, limits })
  cleanups.push(
    () => grants.close(),
    () => listener.close(),
    () => answerer.close()
  )
  const grant = (hubKey = 'hub') => {
    const token = `tok-${++n}-${'x'.repeat(40)}`
    const grantId = `g${n}`
    grants.grant(hubKey, {
      grantId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      userId: 'u1',
      resource: { kind: 'pty', sessionId: 's1' },
      ttlMs: 60_000
    })
    return { token, grantId }
  }
  return { grants, listener, answerer, grant }
}

/** A client peer: offer with every candidate gathered, the channel it opened. */
async function clientOffer() {
  const pc = new rtc.RTCPeerConnection({ iceServers: [] })
  cleanups.push(() => pc.close())
  const channel = pc.createDataChannel(DIRECT_RTC_CHANNEL_LABEL)
  await pc.setLocalDescription(await pc.createOffer())
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve()
  })
  return { pc, channel, sdp: pc.localDescription!.sdp }
}

const opened = (channel: RTCDataChannel, ms = 5_000) =>
  new Promise<boolean>((resolve) => {
    if (channel.readyState === 'open') return resolve(true)
    channel.addEventListener('open', () => resolve(true))
    setTimeout(() => resolve(false), ms)
  })

describe('rtc answerer', () => {
  it('answers an offer for a registered grant; the channel serves the direct protocol', async () => {
    const { answerer, grant } = await setup()
    const { token, grantId } = grant()
    const client = await clientOffer()
    const answer = await answerer.answer('hub', {
      grantId,
      sdp: client.sdp,
      stunAddresses: [],
      clientAddress: '198.51.100.7'
    })
    await client.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    expect(await opened(client.channel)).toBe(true)
    const ws = createWSClient({
      url: 'rtc://direct',
      WebSocket: channelWebSocket(client.channel, { maxMessageChars: 1 << 20 }) as never,
      connectionParams: { token },
      retryDelayMs: () => 60_000
    })
    cleanups.push(() => ws.close())
    const trpc = createTRPCClient<DirectRouter>({
      links: [wsLink({ client: ws, transformer: wireSuperjson })]
    })
    expect(await trpc.ping.query()).toEqual({ protocol: 1 })
    expect(answerer.size()).toBe(1)
  })

  it('refuses an offer for an unknown grant, or one another hub registered', async () => {
    const { answerer, grant } = await setup()
    const other = grant('other-hub')
    const client = await clientOffer()
    for (const grantId of ['nope', other.grantId]) {
      await expect(
        answerer.answer('hub', { grantId, sdp: client.sdp, stunAddresses: [], clientAddress: null })
      ).rejects.toThrow(/no live grant/)
    }
    expect(answerer.size()).toBe(0)
  })

  it('caps peers still connecting per hub', async () => {
    const { answerer, grant } = await setup({ pendingPerHub: 1, connectTimeoutMs: 60_000 })
    const a = grant()
    const first = await clientOffer()
    await answerer.answer('hub', {
      grantId: a.grantId,
      sdp: first.sdp,
      stunAddresses: [],
      clientAddress: null
    })
    const second = await clientOffer()
    await expect(
      answerer.answer('hub', {
        grantId: a.grantId,
        sdp: second.sdp,
        stunAddresses: [],
        clientAddress: null
      })
    ).rejects.toThrow(/too many/)
  })

  it('a tampered DTLS fingerprint never connects, and the computer gives up on it', async () => {
    const { answerer, grant } = await setup({ connectTimeoutMs: 1_500 })
    const { grantId } = grant()
    const client = await clientOffer()
    const answer = await answerer.answer('hub', {
      grantId,
      sdp: client.sdp,
      stunAddresses: [],
      clientAddress: null
    })
    // A broker in the middle swapping the computer's certificate fingerprint.
    const forged = answer.sdp.replace(
      /a=fingerprint:sha-256 ([0-9A-F:]+)/,
      (_m, fp: string) =>
        `a=fingerprint:sha-256 ${fp.replace(/^[0-9A-F]{2}/, fp.startsWith('00') ? '11' : '00')}`
    )
    expect(forged).not.toBe(answer.sdp)
    await client.pc.setRemoteDescription({ type: 'answer', sdp: forged })
    expect(await opened(client.channel, 3_000)).toBe(false)
    await new Promise((r) => setTimeout(r, 300))
    expect(answerer.size()).toBe(0)
  })

  it('revoking the grant ends the channel and the peer', async () => {
    const { answerer, grant, grants } = await setup()
    const { token, grantId } = grant()
    const client = await clientOffer()
    const answer = await answerer.answer('hub', {
      grantId,
      sdp: client.sdp,
      stunAddresses: [],
      clientAddress: null
    })
    await client.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    expect(await opened(client.channel)).toBe(true)
    const ws = createWSClient({
      url: 'rtc://direct',
      WebSocket: channelWebSocket(client.channel, { maxMessageChars: 1 << 20 }) as never,
      connectionParams: { token },
      retryDelayMs: () => 60_000
    })
    cleanups.push(() => ws.close())
    const trpc = createTRPCClient<DirectRouter>({
      links: [wsLink({ client: ws, transformer: wireSuperjson })]
    })
    await trpc.ping.query()
    grants.revoke('hub', { by: 'grant', grantIds: [grantId] })
    const end = Date.now() + 5_000
    while (answerer.size() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    expect(answerer.size()).toBe(0)
  })
})
