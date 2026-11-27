/**
 * Values derived from SLAYZONE_HUB_AUTH_SECRET (T-11): stable, label-separated, one-way.
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  deriveBootstrapOwnerPassword,
  deriveHubCredentialsKey,
  deriveFromHubAuthSecret,
  HUB_AUTH_SECRET_LABELS
} from './hub-auth-secret'

const SECRET = 'a-test-only-hub-auth-secret-0123456789abcdef'

describe('hub auth secret derivations', () => {
  it('is HKDF-SHA256, no salt, the label as info', () => {
    const label = HUB_AUTH_SECRET_LABELS.bootstrapOwnerPassword
    const expected = Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(0), label, 32))
    expect(deriveFromHubAuthSecret(SECRET, label, 32).equals(expected)).toBe(true)
  })

  it('the owner password is stable, 128-bit base64url, and differs per secret', () => {
    const a = deriveBootstrapOwnerPassword(SECRET)
    expect(a).toBe(deriveBootstrapOwnerPassword(SECRET))
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(deriveBootstrapOwnerPassword(`${SECRET}x`)).not.toBe(a)
  })

  it('never contains the secret or a value the secret is otherwise used as', () => {
    const password = deriveBootstrapOwnerPassword(SECRET)
    expect(password).not.toContain(SECRET.slice(0, 8))
    // better-auth signs cookies with HMAC-SHA256 keyed by the raw secret.
    const hmac = createHmac('sha256', SECRET)
      .update(HUB_AUTH_SECRET_LABELS.bootstrapOwnerPassword)
      .digest()
      .subarray(0, 16)
      .toString('base64url')
    expect(password).not.toBe(hmac)
  })

  it('every label is distinct', () => {
    const labels = Object.values(HUB_AUTH_SECRET_LABELS)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('the integration-credentials key is 32 bytes, stable, and its own label', () => {
    const key = deriveHubCredentialsKey(SECRET)
    expect(key).toHaveLength(32)
    expect(key.equals(deriveHubCredentialsKey(SECRET))).toBe(true)
    expect(key.equals(deriveHubCredentialsKey(`${SECRET}x`))).toBe(false)
    expect(HUB_AUTH_SECRET_LABELS.integrationCredentials).toBe(
      'slayzone-hub/integration-credentials/v1'
    )
    const owner = deriveFromHubAuthSecret(SECRET, HUB_AUTH_SECRET_LABELS.bootstrapOwnerPassword, 32)
    expect(key.equals(owner)).toBe(false)
  })

  it('refuses an empty secret rather than deriving from nothing', () => {
    expect(() => deriveBootstrapOwnerPassword('')).toThrow(/empty/)
  })
})
