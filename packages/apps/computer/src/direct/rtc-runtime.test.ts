/**
 * The computer's WebRTC runtime (docs/direct-link.md): node-datachannel, loaded
 * lazily and optional — a computer without it simply does not offer WebRTC.
 */
import { afterEach, expect, it } from 'vitest'
import { loadRtcRuntime } from './rtc-runtime'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

it('loads node-datachannel and moves a message between two in-process peers', async () => {
  const rtc = loadRtcRuntime()
  expect(rtc).not.toBeNull()
  if (!rtc) return
  const a = new rtc.PeerConnection('a', { iceServers: [] })
  const b = new rtc.PeerConnection('b', { iceServers: [] })
  cleanups.push(
    () => a.close(),
    () => b.close()
  )
  a.onLocalDescription((sdp, type) => b.setRemoteDescription(sdp, type))
  a.onLocalCandidate((c, mid) => b.addRemoteCandidate(c, mid))
  b.onLocalDescription((sdp, type) => a.setRemoteDescription(sdp, type))
  b.onLocalCandidate((c, mid) => a.addRemoteCandidate(c, mid))
  const got = new Promise<string>((resolve) => {
    b.onDataChannel((dc) => dc.onMessage((m) => resolve(String(m))))
  })
  const dc = a.createDataChannel('direct')
  dc.onOpen(() => dc.sendMessage('hello'))
  expect(await got).toBe('hello')
})
