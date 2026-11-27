import type { SlayzoneDb } from '@slayzone/platform'
import {
  assertHubIntegrationsEnabled,
  hubIntegrationsEnabled
} from '@slayzone/platform/hub-switch-refusal'
import { type FaultLedger, forEachIsolated, isStorageFatal } from '@slayzone/platform/isolation'
import {
  type CredentialKeyRing,
  decryptHubCredential,
  encryptHubCredential,
  HubCredentialError,
  credentialKeyId,
  isHubCredential
} from './hub-cipher'

/**
 * Integration tokens, stored in `settings` under `integration:credential:<ref>`.
 *
 * The hub encrypts them itself, under its own key ({@link setCredentialKeyRing},
 * resolved at boot: the desktop app's per-install key, an operator's
 * `SLAYZONE_HUB_CREDENTIALS_SECRET`, or a derivation of the hub auth secret). It
 * writes ONE format, `hub1:` (./hub-cipher.ts), and never plaintext: with no key,
 * storing refuses.
 *
 * It READS every format a hub may find in its database, because rows outlive the
 * code that wrote them (a restored backup brings old rows back):
 *   - `hub1:`  this hub's format. A previous key re-encrypts under the current one.
 *   - `plain:` written by older standalone hubs and by desktop Linux without a
 *              keyring. Read, and re-encrypted once a key exists.
 *   - bare base64 = Electron safeStorage, written by older desktop hubs. Decrypted
 *              through the desktop's decrypt-only legacy capability
 *              ({@link setLegacyCredentialDecryptor}), and re-encrypted.
 * A row this hub cannot decrypt (legacy with no decryptor, `hub1:` under a key it
 * does not hold) is KEPT and reported as {@link CREDENTIAL_RECONNECT_REQUIRED}: the
 * user reconnects the integration, which replaces it. Deleting it would lose the only
 * copy should a decryptor come back.
 */

let keyRing: CredentialKeyRing | null = null
let legacyDecryptor: LegacyCredentialDecryptor | null = null

/** The hub's credential keys. `null` = none: reads of old formats only, no writes. */
export function setCredentialKeyRing(ring: CredentialKeyRing | null): void {
  keyRing = ring
}

/**
 * Decrypt-only access to ciphertext an older desktop hub wrote with Electron
 * safeStorage. Kept permanently on the desktop: old backups live for years.
 */
export interface LegacyCredentialDecryptor {
  decrypt: (encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
}

export function setLegacyCredentialDecryptor(d: LegacyCredentialDecryptor | null): void {
  legacyDecryptor = d
}

export const CREDENTIAL_RECONNECT_REQUIRED = 'CREDENTIAL_RECONNECT_REQUIRED'

/** The stored credential exists but this hub cannot decrypt it. The row is kept. */
export class CredentialReconnectRequiredError extends Error {
  readonly code = CREDENTIAL_RECONNECT_REQUIRED
  constructor(message: string) {
    super(message)
    this.name = 'CredentialReconnectRequiredError'
  }
}

/** Shown on the connection (`auth_error`) so the Integrations UI offers Reconnect. */
export const RECONNECT_AUTH_ERROR =
  'This hub cannot decrypt the stored credential — reconnect to continue.'

const PLAINTEXT_PREFIX = 'plain:'

function toSettingKey(ref: string): string {
  return `integration:credential:${ref}`
}

function encrypt(ref: string, secret: string): string {
  if (!keyRing) {
    throw new Error(
      'No credential key on this hub: set SLAYZONE_HUB_CREDENTIALS_SECRET or SLAYZONE_HUB_AUTH_SECRET'
    )
  }
  return encryptHubCredential(keyRing, toSettingKey(ref), secret)
}

/**
 * `SLAYZONE_HUB_ENABLE_INTEGRATIONS=0` refuses both directions here: no
 * `integration:credential:*` row is written, and none is read — every provider call
 * needs one, so a row left from before the switch was turned off cannot reach a
 * provider either.
 */
export async function storeCredential(db: SlayzoneDb, ref: string, secret: string): Promise<void> {
  assertHubIntegrationsEnabled({ op: 'credential.store' })
  await db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(toSettingKey(ref), encrypt(ref, secret))
}

/**
 * Decrypt one stored value. `migrate` = it is not this hub's current format and
 * should be re-encrypted (only possible once a key exists).
 */
async function decryptStored(
  ref: string,
  value: string
): Promise<{ secret: string; migrate: boolean }> {
  if (value.startsWith(PLAINTEXT_PREFIX)) {
    return { secret: value.slice(PLAINTEXT_PREFIX.length), migrate: true }
  }
  if (isHubCredential(value)) {
    if (!keyRing) {
      throw new CredentialReconnectRequiredError('This hub has no credential key')
    }
    try {
      const { result, shouldReEncrypt } = decryptHubCredential(keyRing, toSettingKey(ref), value)
      return { secret: result, migrate: shouldReEncrypt }
    } catch (err) {
      if (err instanceof HubCredentialError && err.code === 'wrong-key') {
        throw new CredentialReconnectRequiredError(err.message)
      }
      throw err
    }
  }
  if (!legacyDecryptor) {
    throw new CredentialReconnectRequiredError(
      'Credential was encrypted by the desktop app (safeStorage), which this hub cannot reach'
    )
  }
  const { result } = await legacyDecryptor.decrypt(Buffer.from(value, 'base64'))
  return { secret: result, migrate: true }
}

export async function readCredential(db: SlayzoneDb, ref: string): Promise<string> {
  assertHubIntegrationsEnabled({ op: 'credential.read' })
  const row = (await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(toSettingKey(ref))) as { value: string } | undefined
  if (!row?.value) {
    throw new Error('Credential not found')
  }
  const { secret, migrate } = await decryptStored(ref, row.value)
  if (migrate && keyRing) await reEncrypt(db, ref, row.value, secret)
  return secret
}

/**
 * Old format or old key → persist fresh `hub1:` ciphertext. Compare-and-swap on the
 * old value so a concurrent `storeCredential` is never overwritten with the stale
 * secret. Best-effort: the decrypt already succeeded, so a failed write-back must not
 * fail the read (the next read retries).
 */
async function reEncrypt(db: SlayzoneDb, ref: string, prev: string, secret: string): Promise<void> {
  try {
    await db
      .prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
      .run(encrypt(ref, secret), toSettingKey(ref), prev)
  } catch {
    /* retried on the next read */
  }
}

export async function deleteCredential(db: SlayzoneDb, ref: string): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').run(toSettingKey(ref))
}

/**
 * Whether a stored value can never be decrypted on this hub as configured (no
 * decrypt attempted): a legacy safeStorage row with no legacy decryptor, or a `hub1:`
 * row under a key the ring does not hold.
 */
export function credentialNeedsReconnect(value: string): boolean {
  if (value.startsWith(PLAINTEXT_PREFIX)) return false
  if (isHubCredential(value)) {
    if (!keyRing) return true
    const kid = value.slice('hub1:'.length).split(':')[0]
    return ![keyRing.current, ...(keyRing.previous ?? [])].some((k) => credentialKeyId(k) === kid)
  }
  return legacyDecryptor === null
}

/**
 * Set (durably) before a `plain:` row is re-encrypted, cleared once the database file
 * was compacted. Re-encrypting a row does not remove the old bytes from the SQLite
 * file — they stay in free pages, unused page space and WAL frames until a VACUUM and
 * a checkpoint — so "no plaintext at rest" holds only after that compaction. A crash
 * in between leaves the flag, and the next pass compacts. Internal + machine-local in
 * the settings registry (settings-core registry.ts).
 */
const COMPACTION_PENDING_SETTING = 'integration.credentials_compaction_pending'

export interface CredentialMigrationReport {
  /** The pass did not run: integrations are switched off on this hub. */
  skipped: boolean
  migrated: number
  reconnect: number
  failed: number
}

/**
 * Boot pass: bring every stored credential to `hub1:` under the current key, so no
 * plaintext or safeStorage ciphertext stays at rest (including rows a restored backup
 * brought back). One row's failure never stops the others (`forEachIsolated`, with an
 * optional fault ledger for backoff). A row that cannot be decrypted is kept and its
 * connection marked {@link RECONNECT_AUTH_ERROR}; a mark this pass set is cleared once
 * the row reads again. Inert when integrations are switched off (nothing is read) or
 * the hub has no key (nothing could be written).
 */
export async function migrateStoredCredentials(
  db: SlayzoneDb,
  opts: {
    ledger?: FaultLedger
    /** VACUUM + WAL checkpoint of the hub database; throws when not achieved. */
    compact?: () => Promise<void>
  } = {}
): Promise<CredentialMigrationReport> {
  const report: CredentialMigrationReport = { skipped: false, migrated: 0, reconnect: 0, failed: 0 }
  if (!hubIntegrationsEnabled() || !keyRing) return { ...report, skipped: true }
  const prefix = toSettingKey('')
  const rows = (await db
    .prepare('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?')
    .all(prefix.length, prefix)) as Array<{ key: string; value: string }>
  const result = await forEachIsolated(
    rows,
    {
      pass: 'hub-credential-migration',
      key: (r) => r.key,
      fingerprint: (r) => r.value,
      ledger: opts.ledger,
      isFatal: isStorageFatal
    },
    async ({ key, value }) => {
      const ref = key.slice(prefix.length)
      let readable = true
      try {
        const { secret, migrate } = await decryptStored(ref, value)
        if (migrate && value.startsWith(PLAINTEXT_PREFIX)) {
          await db
            .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
            .run(COMPACTION_PENDING_SETTING, '1')
        }
        if (migrate) {
          await db
            .prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
            .run(encrypt(ref, secret), key, value)
          report.migrated++
        }
      } catch (err) {
        if (!(err instanceof CredentialReconnectRequiredError)) throw err
        readable = false
        report.reconnect++
        await db
          .prepare(
            `UPDATE integration_connections
             SET enabled = 0, auth_error = ?, auth_error_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE credential_ref = ? AND (auth_error IS NULL OR auth_error = ?)`
          )
          .run(RECONNECT_AUTH_ERROR, ref, RECONNECT_AUTH_ERROR)
      }
      if (readable) {
        await db
          .prepare(
            `UPDATE integration_connections
             SET enabled = 1, auth_error = NULL, auth_error_at = NULL,
                 updated_at = datetime('now')
             WHERE credential_ref = ? AND auth_error = ?`
          )
          .run(ref, RECONNECT_AUTH_ERROR)
      }
    }
  )
  report.failed = result.failed.length
  const pending = await db
    .prepare('SELECT 1 AS one FROM settings WHERE key = ?')
    .get(COMPACTION_PENDING_SETTING)
  if (pending && opts.compact) {
    await opts.compact()
    await db.prepare('DELETE FROM settings WHERE key = ?').run(COMPACTION_PENDING_SETTING)
  }
  return report
}
