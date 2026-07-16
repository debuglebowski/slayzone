import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  setHubTokenCipher,
  setHubToken,
  getHubToken,
  getAllHubTokens,
  type TokenCipher
} from './hub-tokens'

// Reversible fake cipher (base64 tag) — proves the store round-trips through a
// cipher without needing Electron safeStorage.
const fakeCipher: TokenCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, '')
}

describe('hub-tokens', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slayzone-hub-tokens-'))
    setHubTokenCipher(fakeCipher)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    setHubTokenCipher(null)
  })

  it('round-trips a token (encrypted at rest, decrypted on read)', () => {
    setHubToken(dir, 'hub-a', 'secret-123')
    expect(getHubToken(dir, 'hub-a')).toBe('secret-123')
    // On-disk blob must be the CIPHERTEXT, never the plaintext.
    const raw = readFileSync(join(dir, 'hub-tokens.json'), 'utf8')
    expect(raw).not.toContain('secret-123')
    expect(JSON.parse(raw)['hub-a']).toBe(Buffer.from('enc:secret-123').toString('base64'))
  })

  it('getAllHubTokens returns every decrypted pair', () => {
    setHubToken(dir, 'hub-a', 'ta')
    setHubToken(dir, 'hub-b', 'tb')
    expect(getAllHubTokens(dir)).toEqual({ 'hub-a': 'ta', 'hub-b': 'tb' })
  })

  it('clears a token when set to empty', () => {
    setHubToken(dir, 'hub-a', 'ta')
    setHubToken(dir, 'hub-a', '')
    expect(getHubToken(dir, 'hub-a')).toBeNull()
    expect(getAllHubTokens(dir)).toEqual({})
  })

  it('returns null / empty when no cipher is available (safeStorage off)', () => {
    setHubToken(dir, 'hub-a', 'ta')
    setHubTokenCipher(null)
    expect(getHubToken(dir, 'hub-a')).toBeNull()
    expect(getAllHubTokens(dir)).toEqual({})
  })

  it('refuses to persist plaintext when the cipher is unavailable', () => {
    setHubTokenCipher(null)
    expect(() => setHubToken(dir, 'hub-a', 'ta')).toThrow(/safeStorage/)
  })

  it('missing file reads as empty (no throw)', () => {
    expect(getAllHubTokens(dir)).toEqual({})
    expect(getHubToken(dir, 'nope')).toBeNull()
  })
})
