import electron from 'electron'
import type { CredentialCipher } from '../server/credentials'

/**
 * Electron safeStorage-backed CredentialCipher. Wired into the server credential
 * store at boot via `setCredentialCipher`. Returns null when safeStorage isn't
 * exported (non-Electron runtime) so the store falls back to plaintext (test/dev).
 */
export function getSafeStorageCipher(): CredentialCipher | null {
  const safeStorage = (electron as unknown as { safeStorage?: CredentialCipher }).safeStorage
  return safeStorage ?? null
}
