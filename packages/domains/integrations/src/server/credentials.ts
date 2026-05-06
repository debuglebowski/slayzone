import type { Database } from 'better-sqlite3'
import { getStorageAdapter } from './storage-adapter'

const PLAINTEXT_PREFIX = 'plain:'

function allowPlaintextFallback(): boolean {
  return (
    process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS === '1' ||
    process.env.NODE_ENV === 'test'
  )
}

function toSettingKey(ref: string): string {
  return `integration:credential:${ref}`
}

export function storeCredential(db: Database, ref: string, secret: string): void {
  const adapter = getStorageAdapter()
  if (!adapter || !adapter.isAvailable()) {
    if (!allowPlaintextFallback()) {
      throw new Error('Secure credential storage is unavailable')
    }
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      toSettingKey(ref),
      `${PLAINTEXT_PREFIX}${secret}`
    )
    return
  }

  const encrypted = adapter.encrypt(secret)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    toSettingKey(ref),
    encrypted.toString('base64')
  )
}

export function readCredential(db: Database, ref: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(toSettingKey(ref)) as
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

  const adapter = getStorageAdapter()
  if (!adapter || !adapter.isAvailable()) {
    throw new Error('Secure credential storage is unavailable')
  }

  return adapter.decrypt(Buffer.from(row.value, 'base64'))
}

export function deleteCredential(db: Database, ref: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(toSettingKey(ref))
}
