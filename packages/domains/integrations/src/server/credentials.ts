import type { SlayzoneDb } from '@slayzone/platform'
import { assertHubIntegrationsEnabled } from '@slayzone/platform/hub-switch-refusal'

/**
 * OS secure-credential cipher seam — electron-free so this store lives in server/.
 * The Electron host injects a safeStorage-backed cipher at boot via
 * `setCredentialCipher` (../electron/credentials-cipher); the supervised side-car
 * injects one that forwards to the host over the capability bridge. Until
 * injected, `cipher` is null → the plaintext fallback applies (see
 * allowPlaintextFallback).
 *
 * Mirrors Electron's ASYNC safeStorage API (`isAsyncEncryptionAvailable` /
 * `encryptStringAsync` / `decryptStringAsync`; the sync trio is deprecated in
 * Electron 45, removed in 46). Ciphertext written by the old sync
 * `encryptString` stays decryptable by `decryptStringAsync`.
 */
export interface CredentialCipher {
  isEncryptionAvailable: () => Promise<boolean>
  encryptString: (secret: string) => Promise<Buffer>
  /**
   * `shouldReEncrypt` — the OS key rotated (or a stronger one is available):
   * the caller re-encrypts `result` and persists the new ciphertext.
   */
  decryptString: (encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
}

let cipher: CredentialCipher | null = null

export function setCredentialCipher(c: CredentialCipher | null): void {
  cipher = c
}

const PLAINTEXT_PREFIX = 'plain:'

/**
 * Whether plaintext credential storage is permitted. DERIVED from the runtime,
 * not an env flag: a headless standalone hub has no OS keychain (no cipher wired,
 * or a wired cipher whose `isEncryptionAvailable()` is false), so plaintext is its
 * ONLY option and forcing an extra opt-in flag was pure ceremony. Encryption is
 * used whenever a working cipher exists — plaintext is a fallback, never a
 * preference. Never NODE_ENV: a process started with `test` must not read
 * plaintext past a working keychain (unit tests inject no cipher instead).
 * Replaces the former SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS knob.
 */
async function cipherAvailable(): Promise<boolean> {
  return cipher != null && (await cipher.isEncryptionAvailable())
}

async function allowPlaintextFallback(): Promise<boolean> {
  return !(await cipherAvailable())
}

function toSettingKey(ref: string): string {
  return `integration:credential:${ref}`
}

/**
 * `SLAYZONE_HUB_ENABLE_INTEGRATIONS=0` refuses both directions here: no
 * `integration:credential:*` row is written, and none is read — every provider call
 * needs one, so a row left from before the switch was turned off cannot reach a
 * provider either.
 */
export async function storeCredential(db: SlayzoneDb, ref: string, secret: string): Promise<void> {
  assertHubIntegrationsEnabled({ op: 'credential.store' })
  // Encrypt whenever a working cipher exists; otherwise fall back to plaintext
  // (headless standalone hub with no OS keychain). Availability is the sole gate.
  if (await cipherAvailable()) {
    const encrypted = await cipher!.encryptString(secret)
    await db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(toSettingKey(ref), encrypted.toString('base64'))
    return
  }

  if (!(await allowPlaintextFallback())) {
    throw new Error('OS secure credential storage is unavailable on this machine')
  }
  await db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(toSettingKey(ref), `${PLAINTEXT_PREFIX}${secret}`)
}

export async function readCredential(db: SlayzoneDb, ref: string): Promise<string> {
  assertHubIntegrationsEnabled({ op: 'credential.read' })
  const row = (await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(toSettingKey(ref))) as { value: string } | undefined
  if (!row?.value) {
    throw new Error('Credential not found')
  }

  if (row.value.startsWith(PLAINTEXT_PREFIX)) {
    if (!(await allowPlaintextFallback())) {
      throw new Error('Plaintext credential fallback is disabled')
    }
    return row.value.slice(PLAINTEXT_PREFIX.length)
  }

  if (!(await cipherAvailable())) {
    throw new Error('OS secure credential storage is unavailable on this machine')
  }

  const { result, shouldReEncrypt } = await cipher!.decryptString(Buffer.from(row.value, 'base64'))
  if (shouldReEncrypt) await reEncrypt(db, ref, row.value, result)
  return result
}

/**
 * Key rotated → persist fresh ciphertext. Compare-and-swap on the old value so a
 * concurrent `storeCredential` is never overwritten with the stale secret.
 * Best-effort: the decrypt already succeeded, so a failed write-back must not
 * fail the read (the next read retries).
 */
async function reEncrypt(db: SlayzoneDb, ref: string, prev: string, secret: string): Promise<void> {
  try {
    const encrypted = await cipher!.encryptString(secret)
    await db
      .prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
      .run(encrypted.toString('base64'), toSettingKey(ref), prev)
  } catch {
    /* retried on the next read */
  }
}

export async function deleteCredential(db: SlayzoneDb, ref: string): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').run(toSettingKey(ref))
}
