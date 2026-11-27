/**
 * The hub's own credential cipher: AES-256-GCM under a key the HUB holds (no Electron
 * safeStorage), bound to the settings key it is stored under.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  HUB_CREDENTIAL_PREFIX,
  HubCredentialError,
  credentialKeyId,
  decryptHubCredential,
  encryptHubCredential,
  isHubCredential
} from './hub-cipher.js'

const k1 = randomBytes(32)
const k2 = randomBytes(32)
const AAD = 'integration:credential:ref-1'

function flipByte(value: string, at: number): string {
  const [prefix, kid, b64] = value.split(':')
  const bytes = Buffer.from(b64, 'base64')
  bytes[at] ^= 0xff
  return `${prefix}:${kid}:${bytes.toString('base64')}`
}

describe('hub credential cipher', () => {
  test('round-trips; format is hub1:<kid>:<b64>', () => {
    const value = encryptHubCredential({ current: k1 }, AAD, 'lin_api_secret')
    expect(value.startsWith(HUB_CREDENTIAL_PREFIX)).toBe(true)
    expect(value.split(':')).toHaveLength(3)
    expect(value.split(':')[1]).toBe(credentialKeyId(k1))
    expect(value).not.toContain('lin_api_secret')
    expect(isHubCredential(value)).toBe(true)
    expect(decryptHubCredential({ current: k1 }, AAD, value)).toEqual({
      result: 'lin_api_secret',
      shouldReEncrypt: false
    })
  })

  test('a fresh IV per write: same secret, different ciphertext', () => {
    const a = encryptHubCredential({ current: k1 }, AAD, 's')
    const b = encryptHubCredential({ current: k1 }, AAD, 's')
    expect(a).not.toBe(b)
  })

  test('tampered ciphertext, IV or tag fails as corrupt', () => {
    const value = encryptHubCredential({ current: k1 }, AAD, 'secret')
    for (const at of [0, 12, 20, 30]) {
      expect(() => decryptHubCredential({ current: k1 }, AAD, flipByte(value, at))).toThrow(
        expect.objectContaining({ code: 'corrupt' })
      )
    }
  })

  test('a row moved to another settings key does not decrypt (AAD bound)', () => {
    const value = encryptHubCredential({ current: k1 }, AAD, 'secret')
    expect(() =>
      decryptHubCredential({ current: k1 }, 'integration:credential:ref-2', value)
    ).toThrow(HubCredentialError)
  })

  test('a key not in the ring is reported as wrong-key, not corrupt', () => {
    const value = encryptHubCredential({ current: k1 }, AAD, 'secret')
    expect(() => decryptHubCredential({ current: k2 }, AAD, value)).toThrow(
      expect.objectContaining({ code: 'wrong-key' })
    )
  })

  test('a previous key still decrypts and asks for re-encryption', () => {
    const value = encryptHubCredential({ current: k1 }, AAD, 'secret')
    expect(decryptHubCredential({ current: k2, previous: [k1] }, AAD, value)).toEqual({
      result: 'secret',
      shouldReEncrypt: true
    })
  })

  test('malformed values are corrupt, never thrown as anything else', () => {
    for (const bad of ['hub1:', 'hub1:abc', 'hub1:abc:', `hub1:${credentialKeyId(k1)}:AAAA`]) {
      expect(() => decryptHubCredential({ current: k1 }, AAD, bad)).toThrow(
        expect.objectContaining({ code: 'corrupt' })
      )
    }
  })

  test('a key of the wrong length is refused', () => {
    expect(() => encryptHubCredential({ current: randomBytes(16) }, AAD, 's')).toThrow()
  })

  test('isHubCredential recognises only the hub format', () => {
    expect(isHubCredential('plain:x')).toBe(false)
    expect(isHubCredential(Buffer.from('legacy').toString('base64'))).toBe(false)
  })
})
