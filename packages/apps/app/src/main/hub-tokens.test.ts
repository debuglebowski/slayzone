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
    const raw = readFileSync(join(dir, 'client.tokens.json'), 'utf8')
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

  it('writes client.tokens.json and never creates the old name', () => {
    setHubToken(dir, 'hub-a', 'ta')
    expect(existsSync(join(dir, NEW))).toBe(true)
    expect(existsSync(join(dir, OLD))).toBe(false)
  })

  it('reads tokens from the old name in the client dir (beta.14+ layout)', () => {
    writeFileSync(join(dir, OLD), JSON.stringify({ 'hub-a': blob('ta') }))
    expect(getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-a': 'ta' })
    expect(getHubToken(dir, 'hub-a')).toBe('ta') // the same-dir old name needs no legacyDir
  })

  it('reads tokens from the old name in the hub root (older layout)', () => {
    writeFileSync(join(hubRoot, OLD), JSON.stringify({ 'hub-b': blob('tb') }))
    expect(getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-b': 'tb' })
  })

  it('prefers the new file over the old names', () => {
    writeFileSync(join(hubRoot, OLD), JSON.stringify({ 'hub-x': blob('hubroot') }))
    writeFileSync(join(dir, OLD), JSON.stringify({ 'hub-x': blob('olddir') }))
    writeFileSync(join(dir, NEW), JSON.stringify({ 'hub-x': blob('new') }))
    expect(getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-x': 'new' })
  })

  it('a first sign-in after the rename keeps the other hubs’ tokens', () => {
    const oldBytes = JSON.stringify({ 'hub-a': blob('ta'), 'hub-b': blob('tb') })
    writeFileSync(join(dir, OLD), oldBytes)
    setHubToken(dir, 'hub-c', 'tc', hubRoot)
    expect(getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-a': 'ta', 'hub-b': 'tb', 'hub-c': 'tc' })
    expect(readFileSync(join(dir, OLD), 'utf8')).toBe(oldBytes)
  })

  it('a first sign-in carries forward tokens that only exist in the hub root', () => {
    writeFileSync(join(hubRoot, OLD), JSON.stringify({ 'hub-a': blob('ta') }))
    setHubToken(dir, 'hub-c', 'tc', hubRoot)
    expect(getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-a': 'ta', 'hub-c': 'tc' })
  })

  it('signing out writes through to the new file without resurrecting from the old one', () => {
    writeFileSync(join(dir, OLD), JSON.stringify({ 'hub-a': blob('ta'), 'hub-b': blob('tb') }))
    setHubToken(dir, 'hub-a', '', hubRoot)
    expect(getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-b': 'tb' })
  })

  it('an unreadable new file falls through to the old name', () => {
    writeFileSync(join(dir, NEW), '{nope')
    writeFileSync(join(dir, OLD), JSON.stringify({ 'hub-a': blob('ta') }))
    expect(getAllHubTokens(dir, hubRoot)).toEqual({ 'hub-a': 'ta' })
  })
})
