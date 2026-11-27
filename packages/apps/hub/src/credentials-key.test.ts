/**
 * Which key a hub encrypts integration credentials under (D1): the operator's or
 * desktop app's SLAYZONE_HUB_CREDENTIALS_SECRET, else a derivation of a real hub auth
 * secret, else none. Never the shared dev secret: anyone could re-derive that key.
 */
import { describe, expect, test } from 'vitest'
import { deriveHubCredentialsKey } from '@slayzone/platform/hub-auth-secret'
import { resolveCredentialKeyRing } from './credentials-key.js'

const DEV = 'slayzone-dev-computer-secret'
const AUTH = 'a-real-hub-auth-secret-0123456789abcdef0123456789'
const EXPLICIT = 'an-explicit-credentials-secret-0123456789abcdef'

describe('resolveCredentialKeyRing', () => {
  test('a real auth secret alone: key derived from it', () => {
    const ring = resolveCredentialKeyRing({ env: {}, hubAuthSecret: AUTH, devAuthSecret: DEV })
    expect(ring?.current.equals(deriveHubCredentialsKey(AUTH))).toBe(true)
    expect(ring?.previous ?? []).toHaveLength(0)
  })

  test('the shared dev auth secret: no key (it would be public)', () => {
    expect(resolveCredentialKeyRing({ env: {}, hubAuthSecret: DEV, devAuthSecret: DEV })).toBeNull()
  })

  test('SLAYZONE_HUB_CREDENTIALS_SECRET wins; the auth-secret key stays readable', () => {
    const ring = resolveCredentialKeyRing({
      env: { SLAYZONE_HUB_CREDENTIALS_SECRET: EXPLICIT },
      hubAuthSecret: AUTH,
      devAuthSecret: DEV
    })
    expect(ring?.current.equals(deriveHubCredentialsKey(EXPLICIT))).toBe(true)
    expect(ring?.previous?.[0].equals(deriveHubCredentialsKey(AUTH))).toBe(true)
  })

  test('desktop: explicit secret with the dev auth secret, no previous key', () => {
    const ring = resolveCredentialKeyRing({
      env: { SLAYZONE_HUB_CREDENTIALS_SECRET: EXPLICIT },
      hubAuthSecret: DEV,
      devAuthSecret: DEV
    })
    expect(ring?.current.equals(deriveHubCredentialsKey(EXPLICIT))).toBe(true)
    expect(ring?.previous ?? []).toHaveLength(0)
  })

  test('a short explicit secret is refused, never silently weakened', () => {
    expect(() =>
      resolveCredentialKeyRing({
        env: { SLAYZONE_HUB_CREDENTIALS_SECRET: 'short' },
        hubAuthSecret: AUTH,
        devAuthSecret: DEV
      })
    ).toThrow(/SLAYZONE_HUB_CREDENTIALS_SECRET/)
  })
})
