import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_CREDENTIALS_KEY_FILE, loadHubCredentialsSecret } from './hub-credentials-key'
import type { TokenCipher } from './hub-tokens'

// Reversible fake safeStorage: `enc:` = current OS key, `encold:` = rotated key.
const cipher = (available = true): TokenCipher => ({
  isEncryptionAvailable: async () => available,
  encryptString: async (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: async (buf) => {
    const m = /^enc(\w*):(.*)$/s.exec(buf.toString('utf8'))
    if (!m) throw new Error('safeStorage: cannot decrypt')
    return { result: m[2], shouldReEncrypt: m[1] !== '' }
  }
})

describe('desktop hub credentials key', () => {
  let root: string
  const file = () => join(root, HUB_CREDENTIALS_KEY_FILE)
  const onDisk = () => JSON.parse(readFileSync(file(), 'utf8'))
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'slayzone-hub-cred-key-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('first boot generates a 256-bit key, stores it safeStorage-wrapped, 0600', async () => {
    const secret = await loadHubCredentialsSecret(root, cipher())
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(onDisk()).toMatchObject({ v: 1, wrap: 'safeStorage' })
    expect(readFileSync(file(), 'utf8')).not.toContain(secret!)
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it('creates the hub root on a first install', async () => {
    const fresh = join(root, 'not-yet', 'hub')
    const secret = await loadHubCredentialsSecret(fresh, cipher())
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await loadHubCredentialsSecret(fresh, cipher())).toBe(secret)
  })

  it('is stable across boots', async () => {
    const a = await loadHubCredentialsSecret(root, cipher())
    expect(await loadHubCredentialsSecret(root, cipher())).toBe(a)
  })

  it('no safeStorage (Linux without a keyring): unwrapped 0600 file, still stable', async () => {
    const a = await loadHubCredentialsSecret(root, cipher(false))
    expect(onDisk()).toMatchObject({ v: 1, wrap: 'none' })
    expect(await loadHubCredentialsSecret(root, null)).toBe(a)
  })

  it('an unwrapped key is wrapped once safeStorage becomes available', async () => {
    const a = await loadHubCredentialsSecret(root, null)
    expect(await loadHubCredentialsSecret(root, cipher())).toBe(a)
    expect(onDisk()).toMatchObject({ wrap: 'safeStorage' })
    expect(readFileSync(file(), 'utf8')).not.toContain(a!)
  })

  it('a rotated OS key re-wraps, same secret', async () => {
    const a = await loadHubCredentialsSecret(root, cipher())
    const old = Buffer.from(`encold:${a}`).toString('base64')
    writeFileSync(file(), JSON.stringify({ v: 1, wrap: 'safeStorage', data: old }))
    expect(await loadHubCredentialsSecret(root, cipher())).toBe(a)
    expect(onDisk().data).not.toBe(old)
  })

  it('a wrapped key that cannot be unwrapped is NEVER replaced: null, file untouched', async () => {
    writeFileSync(
      file(),
      JSON.stringify({ v: 1, wrap: 'safeStorage', data: Buffer.from('garbage').toString('base64') })
    )
    const before = readFileSync(file(), 'utf8')
    expect(await loadHubCredentialsSecret(root, cipher())).toBeNull()
    expect(await loadHubCredentialsSecret(root, null)).toBeNull()
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })

  it('an unreadable file is never replaced either', async () => {
    writeFileSync(file(), '{not json')
    expect(await loadHubCredentialsSecret(root, cipher())).toBeNull()
    expect(readFileSync(file(), 'utf8')).toBe('{not json')
  })
})
