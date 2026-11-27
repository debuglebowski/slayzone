/**
 * The boot pass that brings every stored integration credential to `hub1:` under the
 * hub's own key, against a real migrated database: plaintext and safeStorage rows are
 * re-encrypted, an undecryptable row is kept and its connection offered Reconnect, and
 * the switch-off promise (no credential is read) holds.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { createAsyncFaultLedger } from '@slayzone/platform/isolation'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import {
  migrateStoredCredentials,
  readCredential,
  setCredentialKeyContext,
  setCredentialKeyRing,
  setLegacyCredentialDecryptor
} from './credentials.js'
import { ensureIntegrationSchema } from './handlers-store.js'
import { encryptHubCredential } from './hub-cipher.js'
import {
  CREDENTIAL_KEY_CHANGED_ERROR,
  CREDENTIAL_KEY_LOCKED_ERROR,
  CREDENTIAL_KEY_UNAVAILABLE_ERROR,
  CREDENTIAL_LEGACY_UNREADABLE_ERROR,
  credentialReconnectReason
} from '../shared/index.js'

const h = await createTestHarness()
await ensureIntegrationSchema(h.slayDb)
const key = randomBytes(32)

const legacyValue = (secret: string) => Buffer.from(`ss:${secret}`).toString('base64')
const legacyDecryptor = {
  decrypt: async (b: Buffer) => ({ result: b.toString('utf8').slice(3), shouldReEncrypt: false })
}

function seed(ref: string, value: string, connId = crypto.randomUUID()): string {
  h.db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(`integration:credential:${ref}`, value)
  h.db
    .prepare(
      `INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
       VALUES (?, 'linear', ?, 1, datetime('now'), datetime('now'))`
    )
    .run(connId, ref)
  return connId
}
const stored = (ref: string) =>
  (
    h.db.prepare('SELECT value FROM settings WHERE key = ?').get(`integration:credential:${ref}`) as
      | { value: string }
      | undefined
  )?.value
const conn = (id: string) =>
  h.db.prepare('SELECT enabled, auth_error FROM integration_connections WHERE id = ?').get(id) as {
    enabled: number
    auth_error: string | null
  }

afterEach(() => {
  setCredentialKeyRing(null)
  setLegacyCredentialDecryptor(null)
  delete process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS
  h.db.prepare("DELETE FROM settings WHERE key LIKE 'integration:credential:%'").run()
  h.db.prepare('DELETE FROM integration_connections').run()
  h.db.prepare('DELETE FROM settings WHERE key = ?').run(COMPACTION_FLAG)
})

const COMPACTION_FLAG = 'integration.credentials_compaction_pending'
const flag = () =>
  h.db.prepare('SELECT value FROM settings WHERE key = ?').get(COMPACTION_FLAG) as
    | { value: string }
    | undefined

describe('credential migration pass', () => {
  test('plaintext rows: the file is compacted after, so no plaintext remnant survives', async () => {
    seed('p', 'plain:ghp_compact_me')
    setCredentialKeyRing({ current: key })
    let compactions = 0
    await migrateStoredCredentials(h.slayDb, {
      compact: async () => {
        compactions++
        expect(flag(), 'the flag is durable before the compaction runs').toBeDefined()
      }
    })
    expect(compactions).toBe(1)
    expect(flag()).toBeUndefined()
  })

  test('a compaction that did not finish is retried at the next pass', async () => {
    seed('p', 'plain:ghp_compact_me')
    setCredentialKeyRing({ current: key })
    await migrateStoredCredentials(h.slayDb, {
      compact: async () => {
        throw new Error('checkpoint busy')
      }
    }).catch(() => {})
    expect(flag()).toBeDefined()
    let compactions = 0
    await migrateStoredCredentials(h.slayDb, { compact: async () => void compactions++ })
    expect(compactions).toBe(1)
    expect(flag()).toBeUndefined()
  })

  test('only ciphertext migrated: no compaction', async () => {
    seed('l', legacyValue('lin_legacy'))
    setCredentialKeyRing({ current: key })
    setLegacyCredentialDecryptor(legacyDecryptor)
    let compactions = 0
    await migrateStoredCredentials(h.slayDb, { compact: async () => void compactions++ })
    expect(compactions).toBe(0)
  })

  test('plain: and safeStorage rows become hub1:, no plaintext left at rest', async () => {
    seed('p', 'plain:ghp_plain')
    seed('l', legacyValue('lin_legacy'))
    setCredentialKeyRing({ current: key })
    setLegacyCredentialDecryptor(legacyDecryptor)
    const report = await migrateStoredCredentials(h.slayDb, {
      ledger: createAsyncFaultLedger(h.slayDb, { origin: 'hub' })
    })
    expect(report).toMatchObject({ skipped: false, migrated: 2, reconnect: 0, failed: 0 })
    expect(stored('p')!.startsWith('hub1:')).toBe(true)
    expect(stored('l')!.startsWith('hub1:')).toBe(true)
    const all = JSON.stringify(h.db.prepare('SELECT value FROM settings').all())
    expect(all).not.toContain('ghp_plain')
    setLegacyCredentialDecryptor(null)
    expect(await readCredential(h.slayDb, 'p')).toBe('ghp_plain')
    expect(await readCredential(h.slayDb, 'l')).toBe('lin_legacy')
  })

  test('a safeStorage row with no decryptor: kept, connection offered Reconnect', async () => {
    const value = legacyValue('lin_legacy')
    const connId = seed('l', value)
    setCredentialKeyRing({ current: key })
    const report = await migrateStoredCredentials(h.slayDb)
    expect(report).toMatchObject({ migrated: 0, reconnect: 1, failed: 0 })
    expect(stored('l')).toBe(value)
    expect(conn(connId)).toEqual({ enabled: 0, auth_error: CREDENTIAL_LEGACY_UNREADABLE_ERROR })
    expect(credentialReconnectReason(conn(connId).auth_error)).toBe(
      CREDENTIAL_LEGACY_UNREADABLE_ERROR
    )
  })

  test("a row under a key this machine doesn't have: the connection says so", async () => {
    const other = randomBytes(32)
    const connId = seed(
      'k',
      encryptHubCredential({ current: other }, 'integration:credential:k', 'x')
    )
    setCredentialKeyRing({ current: key })
    await migrateStoredCredentials(h.slayDb)
    expect(conn(connId)).toEqual({ enabled: 0, auth_error: CREDENTIAL_KEY_UNAVAILABLE_ERROR })
    expect(CREDENTIAL_KEY_UNAVAILABLE_ERROR).toMatch(/key isn.t available on this machine/)
    expect(CREDENTIAL_KEY_UNAVAILABLE_ERROR).toMatch(/reconnect/i)
    // Once the key is back, the mark goes and the connection is enabled again.
    setCredentialKeyRing({ current: other })
    await migrateStoredCredentials(h.slayDb)
    expect(conn(connId)).toEqual({ enabled: 1, auth_error: null })
  })

  test("L5: on a standalone hub a row under another key says the hub's key changed", async () => {
    setCredentialKeyContext('standalone')
    const other = randomBytes(32)
    const connId = seed(
      's',
      encryptHubCredential({ current: other }, 'integration:credential:s', 'x')
    )
    setCredentialKeyRing({ current: key })
    await migrateStoredCredentials(h.slayDb)
    expect(conn(connId)).toEqual({ enabled: 0, auth_error: CREDENTIAL_KEY_CHANGED_ERROR })
    expect(CREDENTIAL_KEY_CHANGED_ERROR).toMatch(/SLAYZONE_HUB_AUTH_SECRET/)
    expect(credentialReconnectReason(CREDENTIAL_KEY_CHANGED_ERROR)).toBe(
      CREDENTIAL_KEY_CHANGED_ERROR
    )
    setCredentialKeyContext('desktop')
  })

  test('a provider error is not a key reason', () => {
    expect(credentialReconnectReason('401 Unauthorized')).toBeNull()
    expect(credentialReconnectReason(null)).toBeNull()
  })

  test('its own Reconnect mark is cleared once the row reads again', async () => {
    const connId = seed('l', legacyValue('lin_legacy'))
    setCredentialKeyRing({ current: key })
    await migrateStoredCredentials(h.slayDb)
    setLegacyCredentialDecryptor(legacyDecryptor)
    await migrateStoredCredentials(h.slayDb)
    expect(conn(connId)).toEqual({ enabled: 1, auth_error: null })
    expect(stored('l')!.startsWith('hub1:')).toBe(true)
  })

  test("a provider's own auth error is never cleared by the pass", async () => {
    const connId = seed('p', 'plain:ghp_x')
    h.db
      .prepare("UPDATE integration_connections SET enabled = 0, auth_error = '401' WHERE id = ?")
      .run(connId)
    setCredentialKeyRing({ current: key })
    await migrateStoredCredentials(h.slayDb)
    expect(conn(connId)).toEqual({ enabled: 0, auth_error: '401' })
  })

  test('inert when integrations are switched off: nothing read or rewritten', async () => {
    seed('p', 'plain:ghp_x')
    setCredentialKeyRing({ current: key })
    process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS = '0'
    const report = await migrateStoredCredentials(h.slayDb)
    expect(report.skipped).toBe(true)
    expect(stored('p')).toBe('plain:ghp_x')
  })

  test('no key: plaintext cannot be replaced, so it is left alone', async () => {
    seed('p', 'plain:ghp_x')
    const report = await migrateStoredCredentials(h.slayDb)
    expect(report.migrated).toBe(0)
    expect(stored('p')).toBe('plain:ghp_x')
  })

  test('L4: desktop with no key yet (keychain locked): "unlock", never "reconnect"; a late key clears it', async () => {
    setCredentialKeyContext('desktop')
    const connId = seed(
      'd',
      encryptHubCredential({ current: key }, 'integration:credential:d', 'x')
    )
    await migrateStoredCredentials(h.slayDb)
    expect(conn(connId)).toEqual({ enabled: 0, auth_error: CREDENTIAL_KEY_LOCKED_ERROR })
    expect(CREDENTIAL_KEY_LOCKED_ERROR).toMatch(/keychain/)
    expect(CREDENTIAL_KEY_LOCKED_ERROR).not.toMatch(/reconnect/i)
    // The key arrives later in the session (composition reruns the pass).
    setCredentialKeyRing({ current: key })
    await migrateStoredCredentials(h.slayDb)
    expect(conn(connId)).toEqual({ enabled: 1, auth_error: null })
  })
})
