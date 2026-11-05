/**
 * The phone's WebRTC peer for the direct link (docs/direct-link.md): with it
 * installed, the phone asks hubs for WebRTC to computers it cannot dial (a remote
 * computer behind NAT), and the hub brokers the connection — no open port, no
 * server setup. Data channels only: no camera or microphone is ever touched, so the
 * app declares no such permission (react-native-webrtc autolinks without its config
 * plugin, whose only job is those permission strings).
 *
 * Loaded on install, not at import: a binary built without the native module (an
 * older build) simply asks for no WebRTC, and the hub answers with the WebSocket
 * path or the relay.
 *
 * @module mobile/direct-rtc
 */
import { setDirectRtcPeerFactory, type DirectRtcPeerFactory } from '@slayzone/transport/client'

type WebRtcModule = typeof import('react-native-webrtc')

/** Installs the peer factory; null when react-native-webrtc is not in this build. */
export function installDirectRtc(): DirectRtcPeerFactory | null {
  let webrtc: WebRtcModule
  try {
    webrtc = require('react-native-webrtc') as WebRtcModule
  } catch {
    return null
  }
  const factory: DirectRtcPeerFactory = (config) =>
    new webrtc.RTCPeerConnection(config as never) as unknown as globalThis.RTCPeerConnection
  setDirectRtcPeerFactory(factory)
  return factory
}
