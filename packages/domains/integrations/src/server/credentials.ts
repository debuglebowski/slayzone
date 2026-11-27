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
import {
  CREDENTIAL_KEY_CHANGED_ERROR,
  CREDENTIAL_KEY_LOCKED_ERROR,
  CREDENTIAL_KEY_UNAVAILABLE_ERROR,
  CREDENTIAL_LEGACY_UNREADABLE_ERROR,
  CREDENTIAL_RECONNECT_REASONS
} from '../shared/credential-reconnect'

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

/**
 * Prefix the desktop puts on the error when safeStorage itself refuses a ciphertext
 * (another Mac's, a reset keychain item): the row can never be read here, unlike a
 * bridge that is merely down (review-2 L5). Plain text, so it survives the bridge.
 */
const LEGACY_UNDECRYPTABLE_TAG = '[slayzone:legacy-undecryptable]'

/** The row can never be decrypted by this desktop: reconnect replaces it. */
export class LegacyCredentialUndecryptableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LegacyCredentialUndecryptableError'
  }
}

/** Desktop side of the bridge: run safeStorage, tag ITS refusals. */
export async function decryptLegacyForBridge(
  decrypt: (encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>,
  b64: string
): Promise<{ result: string; shouldReEncrypt: boolean }> {
  try {
    return await decrypt(Buffer.from(b64, 'base64'))
  } catch (err) {
    throw new Error(
      `${LEGACY_UNDECRYPTABLE_TAG} ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Hub side: the bridge call, with a tagged refusal turned into the typed error. */
export function legacyDecryptorOverBridge(
  decryptB64: (b64: string) => Promise<{ result: string; shouldReEncrypt: boolean }>
): LegacyCredentialDecryptor {
  return {
    decrypt: async (encrypted) => {
      try {
        return await decryptB64(encrypted.toString('base64'))
      } catch (err) {
        if (err instanceof Error && err.message.includes(LEGACY_UNDECRYPTABLE_TAG))
          throw new LegacyCredentialUndecryptableError(err.message)
        throw err
      }
    }
  }
}

/**
 * Who holds this hub's key, so a missing or different key is explained in the user's
 * terms: `desktop` (the app's per-install key in the OS keychain) or `standalone`
 * (derived from the hub's auth secret / an operator's credentials secret, L5).
 */
export type CredentialKeyContext = 'desktop' | 'standalone'
let keyContext: CredentialKeyContext = 'desktop'

export function setCredentialKeyContext(context: CredentialKeyContext): void {
  keyContext = context
}

function wrongKeyReason(): string {
  if (keyContext === 'standalone') return CREDENTIAL_KEY_CHANGED_ERROR
  // No key at all on the desktop = the keychain has not answered: not a reconnect.
  return keyRing ? CREDENTIAL_KEY_UNAVAILABLE_ERROR : CREDENTIAL_KEY_LOCKED_ERROR
}

/** Why storing refuses with no key at all — the user's next step, not a config var. */
function noKeyMessage(): string {
  return keyContext === 'desktop'
    ? "SlayZone could not unlock this hub's key from the OS keychain. Restart SlayZone and allow keychain access, then reconnect."
    : 'No credential key on this hub: set SLAYZONE_HUB_CREDENTIALS_SECRET or SLAYZONE_HUB_AUTH_SECRET'
}

export const CREDENTIAL_RECONNECT_REQUIRED = 'CREDENTIAL_RECONNECT_REQUIRED'

/**
 * The stored credential exists but this hub cannot decrypt it. The row is kept.
 * `message` is the user-facing reason (../shared credential-reconnect.ts), set on the
 * connection so the Integrations UI says why it needs reconnecting.
 */
export class CredentialReconnectRequiredError extends Error {
  readonly code = CREDENTIAL_RECONNECT_REQUIRED
  constructor(message: string) {
    super(message)
    this.name = 'CredentialReconnectRequiredError'
  }
}

const PLAINTEXT_PREFIX = 'plain:'
const OWN_REASONS_SQL = CREDENTIAL_RECONNECT_REASONS.map(() => '?').join(', ')

function toSettingKey(ref: string): string {
  return `integration:credential:${ref}`
}

function encrypt(ref: string, secret: string): string {
  if (!keyRing) throw new Error(noKeyMessage())
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
      throw new CredentialReconnectRequiredError(wrongKeyReason())
    }
    try {
      const { result, shouldReEncrypt } = decryptHubCredential(keyRing, toSettingKey(ref), value)
      return { secret: result, migrate: shouldReEncrypt }
    } catch (err) {
      if (err instanceof HubCredentialError && err.code === 'wrong-key') {
        throw new CredentialReconnectRequiredError(wrongKeyReason())
      }
      throw err
    }
  }
  if (!legacyDecryptor) {
    throw new CredentialReconnectRequiredError(CREDENTIAL_LEGACY_UNREADABLE_ERROR)
  }
  try {
    const { result } = await legacyDecryptor.decrypt(Buffer.from(value, 'base64'))
    return { secret: result, migrate: true }
  } catch (err) {
    // The keychain refused it for good: reconnect. Anything else (the bridge is
    // down) stays a plain error, retried later.
    if (err instanceof LegacyCredentialUndecryptableError)
      throw new CredentialReconnectRequiredError(CREDENTIAL_LEGACY_UNREADABLE_ERROR)
    throw err
  }
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
    // Plaintext leaves the file only after a compaction (L1): flag it BEFORE the
    // rewrite, whichever path — a read here or the boot pass — migrates the row.
    if (prev.startsWith(PLAINTEXT_PREFIX)) await flagCompaction(db)
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

async function flagCompaction(db: SlayzoneDb): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(COMPACTION_PENDING_SETTING, '1')
}

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
 * connection marked with the reason (../shared credential-reconnect.ts); a mark this pass set is cleared once
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
  // Without a key it still runs, marking rows it cannot read (the keychain is locked)
  // but writing nothing; a key that arrives later runs it again (composition).
  if (!hubIntegrationsEnabled()) return { ...report, skipped: true }
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
        if (migrate && keyRing && value.startsWith(PLAINTEXT_PREFIX)) await flagCompaction(db)
        if (migrate && keyRing) {
          await db
            .prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
            .run(encrypt(ref, secret), key, value)
          report.migrated++
        }
      } catch (err) {
        if (!(err instanceof CredentialReconnectRequiredError)) throw err
        readable = false
        report.reconnect++
        // Only over no error or a reason of our own: a provider's error stays.
        await db
          .prepare(
            `UPDATE integration_connections
             SET enabled = 0, auth_error = ?, auth_error_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE credential_ref = ? AND (auth_error IS NULL OR auth_error IN (${OWN_REASONS_SQL}))`
          )
          .run(err.message, ref, ...CREDENTIAL_RECONNECT_REASONS)
      }
      if (readable) {
        await db
          .prepare(
            `UPDATE integration_connections
             SET enabled = 1, auth_error = NULL, auth_error_at = NULL,
                 updated_at = datetime('now')
             WHERE credential_ref = ? AND auth_error IN (${OWN_REASONS_SQL})`
          )
          .run(ref, ...CREDENTIAL_RECONNECT_REASONS)
      }
    }
  )
  report.failed = result.failed.length
  const pending = await db
    .prepare('SELECT 1 AS one FROM settings WHERE key = ?')
    .get(COMPACTION_PENDING_SETTING)
  if (pending && opts.compact && keyRing) {
    await opts.compact()
    await db.prepare('DELETE FROM settings WHERE key = ?').run(COMPACTION_PENDING_SETTING)
  }
  return report
}
