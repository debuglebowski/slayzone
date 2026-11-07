/**
 * The client's WebRTC connect for the direct link (docs/direct-link.md): used when
 * the hub answers `transport: 'webrtc'` (the computer has no listener this client
 * can dial).
 *
 *  1. Create a peer with the hub's STUN servers and the direct protocol's data
 *     channel; make the offer and wait (at most `gatherMs`) for every candidate.
 *  2. Send that one complete offer through the hub (`computers.directRtcConnect`),
 *     which hands it to the grant's computer over its authenticated link and returns
 *     the computer's complete answer. Both descriptions carry the peers' DTLS
 *     certificate fingerprints, and only hub-authenticated links carried them: the
 *     DTLS handshake refuses any other certificate.
 *  3. Wait (at most `connectMs`) for the channel to open, then speak the direct
 *     protocol on it with tRPC — the capability in the first frame, as on the
 *     WebSocket. A failed attempt closes the peer; the caller falls back to the relay.
 *
 * A WebRTC failure is not a failed WebSocket connect, so it never slows the
 * renderer's hub socket (Chromium's per-renderer WebSocket throttle).
 *
 * @module transport/client/direct-rtc
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import type { DirectRouter } from '../direct/router'
import {
  channelWebSocket,
  DIRECT_RTC_LABEL,
  DIRECT_RTC_MAX_MESSAGE_CHARS,
  type RtcChannelLike
} from '../direct/rtc-channel'
import type { DirectConnection } from './direct-link'

/** Creates a peer: the renderer's / React Native's RTCPeerConnection. */
export type DirectRtcPeerFactory = (config: RTCConfiguration) => RTCPeerConnection

/** The hub's broker answer (`@slayzone/computers` `DirectRtcConnectResult`, structurally). */
export type DirectRtcConnectAnswer = { ok: true; sdp: string } | { ok: false; reason: string }

export const DIRECT_RTC_GATHER_MS = 2_000
export const DIRECT_RTC_CONNECT_MS = 8_000

export interface DirectRtcConnectOptions {
  createPeer: DirectRtcPeerFactory
  stunAddresses: readonly string[]
  grantId: string
  token: string
  /** Broker the offer through the hub. */
  connect(grantId: string, sdp: string): Promise<DirectRtcConnectAnswer>
  gatherMs?: number
  connectMs?: number
  keepAlive?: { intervalMs: number; pongTimeoutMs: number }
}

function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const timer = setTimeout(resolve, ms)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState !== 'complete') return
      clearTimeout(timer)
      resolve()
    })
  })
}

function opened(channel: RtcChannelLike, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (channel.readyState === 'open') return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    const prev = channel.onopen
    channel.onopen = (ev) => {
      clearTimeout(timer)
      channel.onopen = prev
      resolve(true)
      prev?.(ev)
    }
  })
}

/**
 * Which way the channel went (Diagnostics): `local` when the chosen pair's local
 * candidate is a host address (same network), `stun` when it is an address a NAT
 * mapped (found through STUN, or learned from the peer). Undefined without stats.
 */
async function routeOf(pc: RTCPeerConnection): Promise<'local' | 'stun' | undefined> {
  const stats = await pc.getStats?.().catch(() => null)
  if (!stats) return undefined
  let localId: string | undefined
  stats.forEach(
    (s: { type?: string; state?: string; nominated?: boolean; localCandidateId?: string }) => {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated)
        localId ??= s.localCandidateId
    }
  )
  if (!localId) return undefined
  const type = (stats.get(localId) as { candidateType?: string } | undefined)?.candidateType
  if (type === 'host') return 'local'
  if (type === 'srflx' || type === 'prflx') return 'stun'
  return undefined
}

export async function openDirectRtcConnection(
  opts: DirectRtcConnectOptions
): Promise<DirectConnection> {
  const pc = opts.createPeer({
    iceServers: opts.stunAddresses.map((a) => ({ urls: `stun:${a}` }))
  })
  try {
    const channel = pc.createDataChannel(DIRECT_RTC_LABEL, {
      ordered: true
    }) as unknown as RtcChannelLike
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc, opts.gatherMs ?? DIRECT_RTC_GATHER_MS)
    const offer = pc.localDescription?.sdp
    if (!offer) throw new Error('no local description')
    const answer = await opts.connect(opts.grantId, offer)
    if (!answer.ok) throw new Error(`direct link offer ${answer.reason}`)
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    if (!(await opened(channel, opts.connectMs ?? DIRECT_RTC_CONNECT_MS))) {
      throw new Error('direct link did not connect (ICE or DTLS failed)')
    }
    const route = await routeOf(pc)
    return { ...channelConnection(pc, channel, opts), ...(route ? { route } : {}) }
  } catch (err) {
    pc.close()
    throw err
  }
}

function channelConnection(
  pc: RTCPeerConnection,
  channel: RtcChannelLike,
  opts: DirectRtcConnectOptions
): DirectConnection {
  const closeListeners: Array<() => void> = []
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    wsClient.close()
    pc.close()
    for (const cb of closeListeners.splice(0)) cb()
  }
  const wsClient = createWSClient({
    url: 'rtc://direct',
    WebSocket: channelWebSocket(channel, {
      maxMessageChars: DIRECT_RTC_MAX_MESSAGE_CHARS
    }) as unknown as typeof WebSocket,
    connectionParams: { token: opts.token },
    // One channel, never reopened: the manager re-acquires (a new offer) instead.
    retryDelayMs: () => 2_147_483_647,
    keepAlive: {
      enabled: true,
      ...(opts.keepAlive ?? { intervalMs: 10_000, pongTimeoutMs: 5_000 })
    },
    onClose: () => queueMicrotask(close)
  })
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close()
  })
  return {
    client: createTRPCClient<DirectRouter>({
      links: [wsLink({ client: wsClient, transformer: wireSuperjson })]
    }),
    onClose: (cb) => {
      if (closed) cb()
      else closeListeners.push(cb)
    },
    close
  }
}
