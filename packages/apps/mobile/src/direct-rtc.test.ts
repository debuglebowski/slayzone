/**
 * The phone reaches computers it cannot dial over WebRTC (docs/direct-link.md):
 * installing react-native-webrtc's peer makes it ask hubs for WebRTC direct links.
 */
import {
  directLinkManagerFor,
  disposeDirectLinkManagers,
  setDirectLinkProbe,
  setDirectRtcPeerFactory
} from '@slayzone/transport/client'

const created: unknown[] = []
jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class {
    constructor(config: unknown) {
      created.push(config)
    }
  }
}))

afterEach(() => {
  setDirectRtcPeerFactory(null)
  setDirectLinkProbe(null)
  disposeDirectLinkManagers()
})

it('asks hubs for WebRTC once the react-native-webrtc peer is installed', async () => {
  const { installDirectRtc } = require('./direct-rtc') as typeof import('./direct-rtc')
  const factory = installDirectRtc()
  factory?.({ iceServers: [] })
  expect(created).toEqual([{ iceServers: [] }])

  const inputs: unknown[] = []
  setDirectLinkProbe(async () => true)
  const client = {
    computers: {
      issueDirectLink: {
        mutate: async (input: unknown) => {
          inputs.push(input)
          return { available: false as const, reason: 'no-address' }
        }
      },
      directRtcConnect: { mutate: async () => ({ ok: false as const, reason: 'refused' }) },
      onStatusChange: { subscribe: () => ({ unsubscribe: () => undefined }) }
    }
  }
  await directLinkManagerFor('hub', client).acquire({ kind: 'pty', sessionId: 's', taskId: 't' })
  expect(inputs).toEqual([
    { target: { kind: 'pty', sessionId: 's', taskId: 't' }, transports: ['ws', 'webrtc'] }
  ])
})
