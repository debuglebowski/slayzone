import { describe, expect, it } from 'vitest'
import {
  DIRECT_RTC_CHANNEL_LABEL,
  DIRECT_RTC_MAX_SDP,
  directRtcAnswerSchema,
  directRtcOfferParamsSchema,
  DIRECT_GRANT_MAX_TTL_MS,
  directGrantParamsSchema,
  directRevokeParamsSchema,
  directResetParamsSchema
} from './direct'
import { HubToComputerMethods } from './frames'

const hash = 'a'.repeat(64)

describe('direct-link grant frames', () => {
  it('names the hub → computer methods', () => {
    expect(HubToComputerMethods.directGrant).toBe('direct.grant')
    expect(HubToComputerMethods.directRevoke).toBe('direct.revoke')
    expect(HubToComputerMethods.directReset).toBe('direct.reset')
  })

  it('accepts a pty and a chat grant', () => {
    for (const resource of [
      { kind: 'pty', sessionId: 't:t' },
      { kind: 'chat', tabId: 'tab', epoch: 3 }
    ]) {
      expect(
        directGrantParamsSchema.safeParse({
          grantId: 'g',
          tokenHash: hash,
          userId: null,
          resource,
          ttlMs: 60_000
        }).success
      ).toBe(true)
    }
  })

  it('refuses a raw token in place of its hash, and an over-long TTL', () => {
    const base = { grantId: 'g', userId: 'u', resource: { kind: 'pty', sessionId: 's' } }
    expect(
      directGrantParamsSchema.safeParse({ ...base, tokenHash: 'not-a-hash', ttlMs: 1 }).success
    ).toBe(false)
    expect(
      directGrantParamsSchema.safeParse({
        ...base,
        tokenHash: hash,
        ttlMs: DIRECT_GRANT_MAX_TTL_MS + 1
      }).success
    ).toBe(false)
  })

  it('revokes by grant, user, resource or all', () => {
    for (const p of [
      { by: 'grant', grantIds: ['g'] },
      { by: 'user', userId: 'u' },
      { by: 'resource', resource: { kind: 'chat', tabId: 't' } },
      { by: 'all' }
    ]) {
      expect(directRevokeParamsSchema.safeParse(p).success).toBe(true)
    }
    expect(directRevokeParamsSchema.safeParse({ by: 'grant', grantIds: [] }).success).toBe(false)
  })

  it('resets to an explicit keep list', () => {
    expect(directResetParamsSchema.safeParse({ keep: [] }).success).toBe(true)
    expect(directResetParamsSchema.safeParse({}).success).toBe(false)
  })
})

// M5: WebRTC for remote computers (docs/direct-link.md). The hub brokers one SDP
// offer/answer per peer, bound to a grant it registered.
describe('direct.rtcOffer', () => {
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n'
  it('is a hub → computer method', () => {
    expect(HubToComputerMethods.directRtcOffer).toBe('direct.rtcOffer')
  })

  it('carries a grant id, an SDP offer and STUN authorities (never URLs)', () => {
    const ok = {
      grantId: 'g',
      sdp,
      stunAddresses: ['stun.cloudflare.com:3478'],
      clientAddress: '198.51.100.7'
    }
    expect(directRtcOfferParamsSchema.safeParse(ok).success).toBe(true)
    expect(
      directRtcOfferParamsSchema.safeParse({ ...ok, stunAddresses: ['stun:x:1'] }).success
    ).toBe(false)
    expect(
      directRtcOfferParamsSchema.safeParse({ ...ok, stunAddresses: Array(9).fill('a:1') }).success
    ).toBe(false)
    expect(
      directRtcOfferParamsSchema.safeParse({ ...ok, sdp: 'x'.repeat(DIRECT_RTC_MAX_SDP + 1) })
        .success
    ).toBe(false)
    expect(directRtcAnswerSchema.safeParse({ sdp }).success).toBe(true)
  })

  it('names the data channel the direct protocol runs on', () => {
    expect(DIRECT_RTC_CHANNEL_LABEL).toBe('slayzone-direct-v1')
  })
})
