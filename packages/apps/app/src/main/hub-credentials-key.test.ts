import fs, {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHubCredentialsKeySource,
  HUB_CREDENTIALS_KEY_FILE,
  loadHubCredentialsKeys
} from './hub-credentials-key'
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
const KEY = /^[A-Za-z0-9_-]{43}$/
const quiet = () => {}

describe('desktop hub credentials key', () => {
  let root: string
  const file = () => join(root, HUB_CREDENTIALS_KEY_FILE)
  const onDisk = () => JSON.parse(readFileSync(file(), 'utf8'))
  const setAside = () => readdirSync(root).filter((n) => n.includes('.unreadable-'))
  const load = (c: TokenCipher | null, dir = root) => loadHubCredentialsKeys(dir, c, quiet)
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'slayzone-hub-cred-key-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('first boot generates a 256-bit key, stores it safeStorage-wrapped, 0600', async () => {
    const keys = await load(cipher())
    expect(keys.current).toMatch(KEY)
    expect(keys.previous).toEqual([])
    expect(onDisk()).toMatchObject({ v: 1, wrap: 'safeStorage' })
    expect(readFileSync(file(), 'utf8')).not.toContain(keys.current!)
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it('creates the hub root on a first install', async () => {
    const fresh = join(root, 'not-yet', 'hub')
    const keys = await load(cipher(), fresh)
    expect(keys.current).toMatch(KEY)
    expect((await load(cipher(), fresh)).current).toBe(keys.current)
  })

  it('is stable across boots', async () => {
    const a = await load(cipher())
    expect((await load(cipher())).current).toBe(a.current)
  })

  it('no safeStorage (Linux without a keyring): unwrapped 0600 file, still stable', async () => {
    const a = await load(cipher(false))
    expect(onDisk()).toMatchObject({ v: 1, wrap: 'none' })
    expect((await load(null)).current).toBe(a.current)
  })

  it('an unwrapped key is wrapped once safeStorage becomes available', async () => {
    const a = await load(null)
    expect((await load(cipher())).current).toBe(a.current)
    expect(onDisk()).toMatchObject({ wrap: 'safeStorage' })
    expect(readFileSync(file(), 'utf8')).not.toContain(a.current!)
  })

  it('a rotated OS key re-wraps, same secret', async () => {
    const a = await load(cipher())
    const old = Buffer.from(`encold:${a.current}`).toString('base64')
    writeFileSync(file(), JSON.stringify({ v: 1, wrap: 'safeStorage', data: old }))
    expect((await load(cipher())).current).toBe(a.current)
    expect(onDisk().data).not.toBe(old)
  })

  it('H2: a key that cannot be unwrapped is SET ASIDE (kept byte for byte) and a new key minted', async () => {
    const garbage = JSON.stringify({
      v: 1,
      wrap: 'safeStorage',
      data: Buffer.from('another machine').toString('base64')
    })
    writeFileSync(file(), garbage)
    const keys = await load(cipher())
    expect(keys.current, 'a new key: reconnecting works again').toMatch(KEY)
    expect(setAside()).toHaveLength(1)
    expect(readFileSync(join(root, setAside()[0]), 'utf8')).toBe(garbage)
    // The new key is the one kept from now on.
    expect((await load(cipher())).current).toBe(keys.current)
    expect(setAside()).toHaveLength(1)
  })

  it('H2: a set-aside key that unwraps again later comes back as a previous key', async () => {
    const lost = 'the-old-key-0123456789abcdefghijklmnopqrstuvw'
    // Wrapped under a keychain entry that is unavailable on this boot…
    writeFileSync(
      file(),
      JSON.stringify({
        v: 1,
        wrap: 'safeStorage',
        data: Buffer.from(`encback:${lost}`).toString('base64')
      })
    )
    const denying: TokenCipher = {
      ...cipher(),
      decryptString: async () => {
        throw new Error('user denied keychain access')
      }
    }
    const first = await load(denying)
    expect(first.previous).toEqual([])
    // …and readable again on a later boot (the keychain came back).
    const second = await load(cipher())
    expect(second.current).toBe(first.current)
    expect(second.previous).toEqual([lost])
  })

  it('an unreadable file is set aside too, never deleted', async () => {
    writeFileSync(file(), '{not json')
    const keys = await load(cipher())
    expect(keys.current).toMatch(KEY)
    expect(readFileSync(join(root, setAside()[0]), 'utf8')).toBe('{not json')
  })

  it('safeStorage unavailable for a wrapped key (transient): no key this boot, nothing moved', async () => {
    const a = await load(cipher())
    const before = readFileSync(file(), 'utf8')
    const keys = await load(cipher(false))
    expect(keys.current).toBeNull()
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(setAside()).toEqual([])
    expect((await load(cipher())).current).toBe(a.current)
  })

  it('L4: the directory is fsynced after the key file is renamed into place', async () => {
    const opened: string[] = []
    const open = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p))
      return (open as (...a: unknown[]) => number)(p, ...rest)
    }) as typeof fs.openSync)
    const sync = vi.spyOn(fs, 'fsyncSync')
    await load(cipher())
    if (process.platform !== 'win32') {
      expect(opened).toContain(root)
      expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('L6: the hub never waits on a keychain prompt', () => {
  it('no answer in time: the hub starts without a key; the key reaches the next start', async () => {
    let unlock!: (keys: { current: string; previous: string[] }) => void
    const source = createHubCredentialsKeySource(
      () =>
        new Promise((resolve) => {
          unlock = resolve
        }),
      { timeoutMs: 20, log: () => {} }
    )
    expect(await source.ready()).toBeNull()
    unlock({ current: 'k'.repeat(43), previous: [] })
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(source.payload()!)).toEqual({ current: 'k'.repeat(43), previous: [] })
  })

  it('answered in time: the first start gets the key', async () => {
    const source = createHubCredentialsKeySource(
      async () => ({ current: 'k'.repeat(43), previous: ['o'.repeat(43)] }),
      { timeoutMs: 1_000, log: () => {} }
    )
    expect(JSON.parse((await source.ready())!)).toEqual({
      current: 'k'.repeat(43),
      previous: ['o'.repeat(43)]
    })
  })

  it('a failed load: no key, logged, never thrown into the hub start', async () => {
    const lines: string[] = []
    const source = createHubCredentialsKeySource(
      async () => {
        throw new Error('keychain exploded')
      },
      { timeoutMs: 1_000, log: (l) => lines.push(l) }
    )
    expect(await source.ready()).toBeNull()
    expect(lines.join('\n')).toMatch(/keychain exploded/)
  })
})
