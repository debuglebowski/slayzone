/**
 * The computer's side of WebRTC signaling (docs/direct-link.md): answer a client's
 * offer, brokered by the hub over its authenticated link, for a grant that hub
 * registered — then serve the data channel through the direct listener exactly like
 * a WebSocket.
 *
 * - **Bound to a grant.** An offer names a live grant this hub registered, or it is
 *   refused before any peer is created. The channel still has to present that
 *   grant's token in its first frame: the offer alone opens nothing.
 * - **No man in the middle.** The client's offer and this answer carry each side's
 *   DTLS certificate fingerprint and travel only over hub-authenticated links; the
 *   DTLS handshake refuses a certificate that does not match the signaled one.
 * - **Bounded.** Peers still connecting per hub and peers in total are capped, an
 *   offer that never connects is dropped after `connectTimeoutMs`, and a peer ends
 *   with its channel (the listener closes the channel when the grants it holds end).
 * - Non-trickle: the answer carries every candidate, gathered for at most
 *   `gatherTimeoutMs`, so signaling is exactly one request per peer.
 *
 * @module computer/direct/rtc-answerer
 */
import {
  ComputerTransportErrorCodes,
  DIRECT_RTC_CHANNEL_LABEL,
  type DirectRtcAnswer,
  type DirectRtcOfferParams,
  RpcError
} from '@slayzone/computer-transport/shared'
import type { RtcChannelLike } from '@slayzone/transport/direct'
import type { DirectGrantStore } from './grants'
import type { DirectListener } from './listener'
import { RtcServerSocket } from './rtc-socket'
import type { RtcPolyfill } from './rtc-runtime'

export interface RtcAnswererLimits {
  /** Peers per hub whose channel has not opened yet. */
  pendingPerHub: number
  /** Peers this computer holds in total. */
  peers: number
  gatherTimeoutMs: number
  /** An answered peer whose channel has not opened by then is closed. */
  connectTimeoutMs: number
  /** Largest reassembled message, as the WebSocket listener's `maxPayload`. */
  maxMessageChars: number
}

export const DEFAULT_RTC_ANSWERER_LIMITS: RtcAnswererLimits = {
  pendingPerHub: 16,
  peers: 64,
  gatherTimeoutMs: 2_000,
  connectTimeoutMs: 20_000,
  maxMessageChars: 1024 * 1024
}

export interface RtcAnswerer {
  answer(hubKey: string, params: DirectRtcOfferParams): Promise<DirectRtcAnswer>
  /** Live peers (connecting or connected). */
  size(): number
  close(): void
}

interface Peer {
  hubKey: string
  pc: RTCPeerConnection
  connected: boolean
  timer: ReturnType<typeof setTimeout> | null
}

function refused(message: string): RpcError {
  return new RpcError(ComputerTransportErrorCodes.refusedByComputer, message)
}

export function createRtcAnswerer(deps: {
  rtc: RtcPolyfill
  grants: Pick<DirectGrantStore, 'get'>
  listener: Pick<DirectListener, 'serveChannel'>
  log: (message: string, detail?: Record<string, unknown>) => void
  limits?: Partial<RtcAnswererLimits>
}): RtcAnswerer {
  const limits: RtcAnswererLimits = { ...DEFAULT_RTC_ANSWERER_LIMITS, ...deps.limits }
  const peers = new Set<Peer>()

  function drop(peer: Peer): void {
    if (!peers.delete(peer)) return
    if (peer.timer) clearTimeout(peer.timer)
    try {
      peer.pc.close()
    } catch {
      /* already closed */
    }
  }

  function gathered(pc: RTCPeerConnection): Promise<void> {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve()
      const timer = setTimeout(resolve, limits.gatherTimeoutMs)
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState !== 'complete') return
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return {
    async answer(hubKey, params) {
      const grant = deps.grants.get(params.grantId)
      if (!grant || grant.hubKey !== hubKey) throw refused('no live grant for this offer')
      if (peers.size >= limits.peers) throw refused('too many direct-link peers')
      const pending = [...peers].filter((p) => p.hubKey === hubKey && !p.connected).length
      if (pending >= limits.pendingPerHub) throw refused('too many direct-link peers connecting')

      const pc = new deps.rtc.RTCPeerConnection({
        iceServers: params.stunAddresses.map((a) => ({ urls: `stun:${a}` }))
      }) as unknown as RTCPeerConnection
      const peer: Peer = { hubKey, pc, connected: false, timer: null }
      peers.add(peer)
      peer.timer = setTimeout(() => {
        if (!peer.connected) {
          deps.log('direct link: WebRTC peer never connected; dropped', { grantId: params.grantId })
          drop(peer)
        }
      }, limits.connectTimeoutMs)
      peer.timer.unref?.()

      pc.addEventListener('datachannel', (ev) => {
        const channel = (ev as RTCDataChannelEvent).channel
        // One channel per peer, the direct protocol's. Anything else is refused.
        if (channel.label !== DIRECT_RTC_CHANNEL_LABEL || peer.connected) {
          channel.close()
          return
        }
        const serve = () => {
          peer.connected = true
          if (peer.timer) clearTimeout(peer.timer)
          peer.timer = null
          const socket = new RtcServerSocket(channel as unknown as RtcChannelLike, {
            maxMessageChars: limits.maxMessageChars
          })
          socket.once('close', () => drop(peer))
          if (!deps.listener.serveChannel(socket, { ip: params.clientAddress })) drop(peer)
        }
        if (channel.readyState === 'open') serve()
        else channel.addEventListener('open', serve, { once: true })
      })
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop(peer)
      })

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: params.sdp })
        await pc.setLocalDescription(await pc.createAnswer())
        await gathered(pc)
        const sdp = pc.localDescription?.sdp
        if (!sdp) throw new Error('no local description')
        return { sdp }
      } catch (err) {
        drop(peer)
        throw refused(
          `WebRTC offer not answered: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    size: () => peers.size,
    close() {
      for (const peer of [...peers]) drop(peer)
    }
  }
}
