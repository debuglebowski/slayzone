/**
 * Which key a hub encrypts integration credentials under (D1): the desktop app's or an
 * operator's secret (credentials-secret-input.ts), else a derivation of a real hub auth
 * secret, else none. Never the shared dev secret: anyone could re-derive that key.
 * Previous keys (a desktop key set aside then recovered, review H2; the auth-secret key
 * behind an explicit one) stay readable.
 */
import { describe, expect, test } from 'vitest'
import { deriveHubCredentialsKey } from '@slayzone/platform/hub-auth-secret'
import { resolveCredentialKeyRing } from './credentials-key.js'

const DEV = 'slayzone-dev-computer-secret'
const AUTH = 'a-real-hub-auth-secret-0123456789abcdef0123456789'
const EXPLICIT = 'an-explicit-credentials-secret-0123456789abcdef'
const OLD = 'an-older-desktop-key-recovered-0123456789abcdef'

const resolve = (over: Partial<Parameters<typeof resolveCredentialKeyRing>[0]>) =>
  resolveCredentialKeyRing({
    secret: null,
    previousSecrets: [],
    hubAuthSecret: AUTH,
    devAuthSecret: DEV,
    ...over
  })

describe('resolveCredentialKeyRing', () => {
  test('a real auth secret alone: key derived from it', () => {
    const ring = resolve({})
    expect(ring?.current.equals(deriveHubCredentialsKey(AUTH))).toBe(true)
    expect(ring?.previous ?? []).toHaveLength(0)
  })

  test('the shared dev auth secret: no key (it would be public)', () => {
    expect(resolve({ hubAuthSecret: DEV })).toBeNull()
  })

  test('an explicit secret wins; the auth-secret key stays readable', () => {
    const ring = resolve({ secret: EXPLICIT })
    expect(ring?.current.equals(deriveHubCredentialsKey(EXPLICIT))).toBe(true)
    expect(ring?.previous?.[0].equals(deriveHubCredentialsKey(AUTH))).toBe(true)
  })

  test('desktop: its key with the dev auth secret; a recovered old key is previous', () => {
    const ring = resolve({ secret: EXPLICIT, previousSecrets: [OLD], hubAuthSecret: DEV })
    expect(ring?.current.equals(deriveHubCredentialsKey(EXPLICIT))).toBe(true)
    expect(ring?.previous?.map((k) => k.toString('hex'))).toEqual([
      deriveHubCredentialsKey(OLD).toString('hex')
    ])
  })

  test('a short explicit secret is refused, never silently weakened', () => {
    expect(() => resolve({ secret: 'short' })).toThrow(/SLAYZONE_HUB_CREDENTIALS_SECRET/)
  })
})
