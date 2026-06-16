import type { SlayzoneDb } from '@slayzone/platform'

/**
 * OS secure-credential cipher seam — electron-free so this store lives in server/.
 * The Electron host injects a safeStorage-backed cipher at boot via
 * `setCredentialCipher` (../electron/credentials-cipher); the standalone server
 * pkg can inject its own (slice 6). Until injected, `cipher` is null → the
 * plaintext fallback applies (test/dev only, gated by allowPlaintextFallback).
 * The interface mirrors Electron's `safeStorage` so the host injects it directly.
 */
/**
 * Mirrors Electron's `safeStorage` so the host can inject it directly. Methods
 * are async-tolerant: the host injects a synchronous safeStorage cipher, while
 * the supervised side-car injects a cipher that forwards to the host over the
 * capability bridge (inherently async). Consumers `await` either shape.
 */
export interface CredentialCipher {
  isEncryptionAvailable: () => boolean | Promise<boolean>
  encryptString: (secret: string) => Buffer | Promise<Buffer>
  decryptString: (encrypted: Buffer) => string | Promise<string>
}

/**
 * Synchronous cipher shape — exactly Electron's `safeStorage`. The host injects
 * one of these directly; it is assignable to the async-tolerant CredentialCipher
 * above (a sync return satisfies `T | Promise<T>`), so the store can `await` it.
 */
export interface SafeStorageCipher {
  isEncryptionAvailable: () => boolean
  encryptString: (secret: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

let cipher: CredentialCipher | null = null

export function setCredentialCipher(c: CredentialCipher | null): void {
  cipher = c
}

const PLAINTEXT_PREFIX = 'plain:'

function allowPlaintextFallback(): boolean {
  return process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS === '1' || process.env.NODE_ENV === 'test'
}

function toSettingKey(ref: string): string {
  return `integration:credential:${ref}`
}

export async function storeCredential(db: SlayzoneDb, ref: string, secret: string): Promise<void> {
  if (!cipher) {
    if (!allowPlaintextFallback()) {
      throw new Error('OS secure credential storage is unavailable on this machine')
    }
    // Node-only / pre-injection fallback (no cipher wired).
    await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      toSettingKey(ref),
      `${PLAINTEXT_PREFIX}${secret}`
    )
    return
  }

  if (!(await cipher.isEncryptionAvailable())) {
    throw new Error('OS secure credential storage is unavailable on this machine')
  }
  const encrypted = await cipher.encryptString(secret)
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    toSettingKey(ref),
    encrypted.toString('base64')
  )
}

export async function readCredential(db: SlayzoneDb, ref: string): Promise<string> {
  const row = (await db.prepare('SELECT value FROM settings WHERE key = ?').get(toSettingKey(ref))) as
    | { value: string }
    | undefined
  if (!row?.value) {
    throw new Error('Credential not found')
  }

  if (row.value.startsWith(PLAINTEXT_PREFIX)) {
    if (!allowPlaintextFallback()) {
      throw new Error('Plaintext credential fallback is disabled')
    }
    return row.value.slice(PLAINTEXT_PREFIX.length)
  }

  if (!cipher || !(await cipher.isEncryptionAvailable())) {
    throw new Error('OS secure credential storage is unavailable on this machine')
  }

  const encrypted = Buffer.from(row.value, 'base64')
  return await cipher.decryptString(encrypted)
}

export async function deleteCredential(db: SlayzoneDb, ref: string): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').run(toSettingKey(ref))
}
