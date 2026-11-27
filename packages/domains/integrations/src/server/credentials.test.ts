/**
 * Credential store contract. The hub writes only `hub1:` (its own key); it reads all
 * three formats it may find — `hub1:`, `plain:` (an older standalone hub, or desktop
 * Linux without a keyring) and bare-base64 Electron safeStorage (an older desktop
 * hub) — and re-encrypts the old two under its key. A row it cannot decrypt is KEPT
 * and reported as reconnect-required, never deleted.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import {
  CREDENTIAL_RECONNECT_REQUIRED,
  credentialNeedsReconnect,
  type LegacyCredentialDecryptor,
  readCredential,
  setCredentialKeyContext,
  setCredentialKeyRing,
  setLegacyCredentialDecryptor,
  storeCredential
} from './credentials.js'
import { encryptHubCredential } from './hub-cipher.js'

class FakeDb {
  private store = new Map<string, string>()

  prepare(sql: string): {
    run: (...args: unknown[]) => void
    get: (...args: unknown[]) => { value: string } | undefined
  } {
    if (sql.startsWith('INSERT OR REPLACE INTO settings')) {
      return {
        run: (key, value) => {
          this.store.set(String(key), String(value))
        },
        get: () => undefined
      }
    }

    if (sql.startsWith('SELECT value FROM settings')) {
      return {
        run: () => {},
        get: (key) => {
          const value = this.store.get(String(key))
          return value === undefined ? undefined : { value }
        }
      }
    }

    if (sql.startsWith('UPDATE settings SET value')) {
      return {
        run: (value, key, expected) => {
          if (this.store.get(String(key)) === String(expected)) {
            this.store.set(String(key), String(value))
          }
        },
        get: () => undefined
      }
    }

    if (sql.startsWith('DELETE FROM settings')) {
      return {
        run: (key) => {
          this.store.delete(String(key))
        },
        get: () => undefined
      }
    }

    throw new Error(`Unhandled SQL in fake DB: ${sql}`)
  }

  raw(key: string): string | undefined {
    return this.store.get(key)
  }

  seed(key: string, value: string): void {
    this.store.set(key, value)
  }
}

const db = new FakeDb()
const k1 = randomBytes(32)
const k2 = randomBytes(32)
const settingKey = (ref: string) => `integration:credential:${ref}`
const newRef = () => `cred-${crypto.randomUUID()}`

// Electron safeStorage stand-in: bare base64 of `ss:<secret>`.
const legacyValue = (secret: string) => Buffer.from(`ss:${secret}`).toString('base64')
const legacy: LegacyCredentialDecryptor = {
  decrypt: async (encrypted) => {
    const text = encrypted.toString('utf8')
    if (!text.startsWith('ss:')) throw new Error('safeStorage: decrypt failed')
    return { result: text.slice(3), shouldReEncrypt: false }
  }
}

afterEach(() => {
  setCredentialKeyContext('desktop')
  setCredentialKeyRing(null)
  setLegacyCredentialDecryptor(null)
})

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

describe('credential store', () => {
  test('writes hub1: under the hub key and reads it back', async () => {
    setCredentialKeyRing({ current: k1 })
    const ref = newRef()
    await storeCredential(db as never, ref, 'lin_api_secret')
    const stored = db.raw(settingKey(ref))!
    expect(stored.startsWith('hub1:')).toBe(true)
    expect(stored).not.toContain('lin_api_secret')
    expect(await readCredential(db as never, ref)).toBe('lin_api_secret')
  })

  test('never writes plaintext: with no key, storing refuses and writes nothing', async () => {
    const ref = newRef()
    await expect(storeCredential(db as never, ref, 'secret')).rejects.toThrow(/key/)
    expect(db.raw(settingKey(ref))).toBeUndefined()
  })

  test('H2: no key on a desktop hub (keychain locked): storing says why, and what to do', async () => {
    setCredentialKeyContext('desktop')
    await expect(storeCredential(db as never, newRef(), 'x')).rejects.toThrow(/keychain.*restart/i)
  })

  test('L1: a plain: row re-encrypted on READ flags the file for compaction', async () => {
    const ref = newRef()
    db.seed(settingKey(ref), 'plain:ghp_read_first')
    setCredentialKeyRing({ current: k1 })
    expect(await readCredential(db as never, ref)).toBe('ghp_read_first')
    expect(db.raw(settingKey(ref))!.startsWith('hub1:')).toBe(true)
    expect(db.raw('integration.credentials_compaction_pending')).toBe('1')
  })

  test('a plain: row is still read once a key exists, and migrated to hub1:', async () => {
    const ref = newRef()
    db.seed(settingKey(ref), 'plain:ghp_old')
    setCredentialKeyRing({ current: k1 })
    expect(await readCredential(db as never, ref)).toBe('ghp_old')
    expect(db.raw(settingKey(ref))!.startsWith('hub1:')).toBe(true)
    expect(await readCredential(db as never, ref)).toBe('ghp_old')
  })

  test('a plain: row is read (not migrated) on a hub without a key', async () => {
    const ref = newRef()
    db.seed(settingKey(ref), 'plain:ghp_old')
    expect(await readCredential(db as never, ref)).toBe('ghp_old')
    expect(db.raw(settingKey(ref))).toBe('plain:ghp_old')
  })

  test('a legacy safeStorage row decrypts through the legacy decryptor and migrates', async () => {
    const ref = newRef()
    db.seed(settingKey(ref), legacyValue('lin_legacy'))
    setCredentialKeyRing({ current: k1 })
    setLegacyCredentialDecryptor(legacy)
    expect(await readCredential(db as never, ref)).toBe('lin_legacy')
    expect(db.raw(settingKey(ref))!.startsWith('hub1:')).toBe(true)
    // Migrated: no longer needs the legacy decryptor.
    setLegacyCredentialDecryptor(null)
    expect(await readCredential(db as never, ref)).toBe('lin_legacy')
  })

  test('a legacy row with no decryptor: reconnect required, row KEPT', async () => {
    const ref = newRef()
    const value = legacyValue('lin_legacy')
    db.seed(settingKey(ref), value)
    setCredentialKeyRing({ current: k1 })
    const err = await errorOf(readCredential(db as never, ref))
    expect(err).toMatchObject({ code: CREDENTIAL_RECONNECT_REQUIRED })
    expect(db.raw(settingKey(ref))).toBe(value)
    expect(credentialNeedsReconnect(value)).toBe(true)
  })

  test('a hub1: row under a key this hub does not hold: reconnect required, row kept', async () => {
    const ref = newRef()
    const value = encryptHubCredential({ current: k2 }, settingKey(ref), 'x')
    db.seed(settingKey(ref), value)
    setCredentialKeyRing({ current: k1 })
    const err = await errorOf(readCredential(db as never, ref))
    expect(err).toMatchObject({ code: CREDENTIAL_RECONNECT_REQUIRED })
    expect(db.raw(settingKey(ref))).toBe(value)
    expect(credentialNeedsReconnect(value)).toBe(true)
  })

  test('a previous key still reads and re-encrypts under the current key', async () => {
    const ref = newRef()
    setCredentialKeyRing({ current: k1 })
    await storeCredential(db as never, ref, 'rotate-me')
    const before = db.raw(settingKey(ref))!
    setCredentialKeyRing({ current: k2, previous: [k1] })
    expect(await readCredential(db as never, ref)).toBe('rotate-me')
    const after = db.raw(settingKey(ref))!
    expect(after).not.toBe(before)
    setCredentialKeyRing({ current: k2 })
    expect(await readCredential(db as never, ref)).toBe('rotate-me')
  })

  test('re-encrypt is compare-and-swap: a concurrent store is never overwritten', async () => {
    const ref = newRef()
    db.seed(settingKey(ref), 'plain:old')
    setCredentialKeyRing({ current: k1 })
    // A store lands between the read's SELECT and its write-back.
    const slowLegacy = db.prepare.bind(db)
    let raced = false
    ;(db as unknown as { prepare: typeof slowLegacy }).prepare = (sql: string) => {
      const stmt = slowLegacy(sql)
      if (!raced && sql.startsWith('UPDATE settings SET value')) {
        raced = true
        db.seed(settingKey(ref), 'plain:new-from-store')
      }
      return stmt
    }
    try {
      expect(await readCredential(db as never, ref)).toBe('old')
    } finally {
      ;(db as unknown as { prepare: typeof slowLegacy }).prepare = slowLegacy
    }
    expect(db.raw(settingKey(ref))).toBe('plain:new-from-store')
  })

  test('a corrupt hub1: row fails loudly but is kept', async () => {
    const ref = newRef()
    setCredentialKeyRing({ current: k1 })
    await storeCredential(db as never, ref, 'x')
    const value = db.raw(settingKey(ref))!
    const broken = `${value.slice(0, -4)}AAAA`
    db.seed(settingKey(ref), broken)
    const err = await errorOf(readCredential(db as never, ref))
    expect(err).not.toMatchObject({ code: CREDENTIAL_RECONNECT_REQUIRED })
    expect(db.raw(settingKey(ref))).toBe(broken)
  })

  test('credentialNeedsReconnect: readable formats are not flagged', () => {
    setCredentialKeyRing({ current: k1 })
    setLegacyCredentialDecryptor(legacy)
    expect(credentialNeedsReconnect('plain:x')).toBe(false)
    expect(credentialNeedsReconnect(legacyValue('x'))).toBe(false)
    expect(credentialNeedsReconnect(encryptHubCredential({ current: k1 }, 'k', 'x'))).toBe(false)
  })
})
