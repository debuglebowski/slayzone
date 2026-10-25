import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// Reversible fake cipher (tag prefix) — proves the store round-trips through a
// cipher without needing Electron safeStorage. `enc:` is the current key; any
// other `enc<n>:` tag is an older key → decrypts with `shouldReEncrypt: true`,
// like safeStorage after a keychain key rotation.
const fakeCipher: TokenCipher = {
  isEncryptionAvailable: async () => true,
  encryptString: async (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: async (buf) => {
    const m = /^enc(\w*):(.*)$/s.exec(buf.toString('utf8'))!
    return { result: m[2], shouldReEncrypt: m[1] !== '' }
  }
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

  it('round-trips a token (encrypted at rest, decrypted on read)', async () => {
    await setHubToken(dir, 'hub-a', 'secret-123')
    expect(await getHubToken(dir, 'hub-a')).toBe('secret-123')
    // On-disk blob must be the CIPHERTEXT, never the plaintext.
    const raw = readFileSync(join(dir, 'client.tokens.json'), 'utf8')
    expect(raw).not.toContain('secret-123')
    expect(JSON.parse(raw)['hub-a']).toBe(Buffer.from('enc:secret-123').toString('base64'))
  })

  it('getAllHubTokens returns every decrypted pair', async () => {
    await setHubToken(dir, 'hub-a', 'ta')
    await setHubToken(dir, 'hub-b', 'tb')
    expect(await getAllHubTokens(dir)).toEqual({ 'hub-a': 'ta', 'hub-b': 'tb' })
  })

  it('clears a token when set to empty', async () => {
    await setHubToken(dir, 'hub-a', 'ta')
    await setHubToken(dir, 'hub-a', '')
    expect(await getHubToken(dir, 'hub-a')).toBeNull()
    expect(await getAllHubTokens(dir)).toEqual({})
  })

  it('returns null / empty when no cipher is available (safeStorage off)', async () => {
    await setHubToken(dir, 'hub-a', 'ta')
    setHubTokenCipher(null)
    expect(await getHubToken(dir, 'hub-a')).toBeNull()
    expect(await getAllHubTokens(dir)).toEqual({})
  })

  it('refuses to persist plaintext when the cipher is unavailable', async () => {
    setHubTokenCipher(null)
    await expect(setHubToken(dir, 'hub-a', 'ta')).rejects.toThrow(/safeStorage/)
  })

  it('re-encrypts + persists a token whose keychain key rotated', async () => {
    writeFileSync(
      join(dir, 'client.tokens.json'),
      JSON.stringify({ 'hub-a': Buffer.from('encold:ta').toString('base64') })
    )
    expect(await getAllHubTokens(dir)).toEqual({ 'hub-a': 'ta' })
    const raw = JSON.parse(readFileSync(join(dir, 'client.tokens.json'), 'utf8'))
    expect(raw['hub-a']).toBe(Buffer.from('enc:ta').toString('base64'))
    expect(await getHubToken(dir, 'hub-a')).toBe('ta')
  })

  it('re-encrypt never clobbers a token rewritten meanwhile', async () => {
    const file = join(dir, 'client.tokens.json')
    writeFileSync(file, JSON.stringify({ 'hub-a': Buffer.from('encold:ta').toString('base64') }))
    // A sign-in lands between the decrypt and the re-encrypt write-back.
    const racing: TokenCipher = {
      ...fakeCipher,
      encryptString: async (plain) => {
        writeFileSync(
          file,
          JSON.stringify({ 'hub-a': Buffer.from('enc:fresh').toString('base64') })
        )
        return fakeCipher.encryptString(plain)
      }
    }
    setHubTokenCipher(racing)
    expect(await getHubToken(dir, 'hub-a')).toBe('ta')
    setHubTokenCipher(fakeCipher)
    expect(await getHubToken(dir, 'hub-a')).toBe('fresh')
  })

  it('missing file reads as empty (no throw)', async () => {
    expect(await getAllHubTokens(dir)).toEqual({})
    expect(await getHubToken(dir, 'nope')).toBeNull()
  })
})

// hub-tokens.json → client.tokens.json. These are the user's saved hub logins, so a
// miss means silently signed out of every remote hub. The old file is read in the
// client dir (beta.14+) and in the hub root (older), a write must not drop the other
// hubs' tokens, and the old file is never modified.
describe('client.tokens.json rename', () => {
  let dir: string
  let hubRoot: string
  const OLD = 'hub-tokens.json'
  const NEW = 'client.tokens.json'
  const blob = (plain: string): string => Buffer.from(`enc:${plain}`).toString('base64')

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'slayzone-tokens-rename-'))
    dir = join(base, 'client')
    hubRoot = join(base, 'hub')
    mkdirSync(dir)
    mkdirSync(hubRoot)
    setHubTokenCipher(fakeCipher)
  })
  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true })
    setHubTokenCipher(null)
  })

  it('writes client.tokens.json and never creates the old name', async () => {
    await setHubToken(dir, 'hub-a', 'ta')
    expect(existsSync(join(dir, NEW))).toBe(true)
    expect(existsSync(join(dir, OLD))).toBe(false)
  })

  it('reads tokens from the old name in the client dir (beta.14+ layout)', async () => {
    writeFileSync(join(dir, OLD), JSON.stringify({ 'hub-a': blob('ta') }))
    expect(await getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-a': 'ta' })
    expect(await getHubToken(dir, 'hub-a')).toBe('ta') // the same-dir old name needs no legacyDir
  })

  it('reads tokens from the old name in the hub root (older layout)', async () => {
    writeFileSync(join(hubRoot, OLD), JSON.stringify({ 'hub-b': blob('tb') }))
    expect(await getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-b': 'tb' })
  })

  it('prefers the new file over the old names', async () => {
    writeFileSync(join(hubRoot, OLD), JSON.stringify({ 'hub-x': blob('hubroot') }))
    writeFileSync(join(dir, OLD), JSON.stringify({ 'hub-x': blob('olddir') }))
    writeFileSync(join(dir, NEW), JSON.stringify({ 'hub-x': blob('new') }))
    expect(await getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-x': 'new' })
  })

  it('a first sign-in after the rename keeps the other hubs’ tokens', async () => {
    const oldBytes = JSON.stringify({ 'hub-a': blob('ta'), 'hub-b': blob('tb') })
    writeFileSync(join(dir, OLD), oldBytes)
    await setHubToken(dir, 'hub-c', 'tc', hubRoot)
    expect(await getAllHubTokens(dir, hubRoot)).toEqual({
      'hub-a': 'ta',
      'hub-b': 'tb',
      'hub-c': 'tc'
    })
    expect(readFileSync(join(dir, OLD), 'utf8')).toBe(oldBytes)
  })

  it('a first sign-in carries forward tokens that only exist in the hub root', async () => {
    writeFileSync(join(hubRoot, OLD), JSON.stringify({ 'hub-a': blob('ta') }))
    await setHubToken(dir, 'hub-c', 'tc', hubRoot)
    expect(await getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-a': 'ta', 'hub-c': 'tc' })
  })

  it('signing out writes through to the new file without resurrecting from the old one', async () => {
    writeFileSync(join(dir, OLD), JSON.stringify({ 'hub-a': blob('ta'), 'hub-b': blob('tb') }))
    await setHubToken(dir, 'hub-a', '', hubRoot)
    expect(await getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-b': 'tb' })
  })

  it('a rotated key never re-encrypts into an old-name file (read-only fallback)', async () => {
    const oldBytes = JSON.stringify({ 'hub-a': Buffer.from('encold:ta').toString('base64') })
    writeFileSync(join(dir, OLD), oldBytes)
    expect(await getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-a': 'ta' })
    expect(readFileSync(join(dir, OLD), 'utf8')).toBe(oldBytes)
    expect(existsSync(join(dir, NEW))).toBe(false)
  })

  it('an unreadable new file falls through to the old name', async () => {
    writeFileSync(join(dir, NEW), '{nope')
    writeFileSync(join(dir, OLD), JSON.stringify({ 'hub-a': blob('ta') }))
    expect(await getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-a': 'ta' })
  })
})
