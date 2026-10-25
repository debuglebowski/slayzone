import electron from 'electron'
import type { CredentialCipher } from '../server/credentials'

/**
 * Electron safeStorage-backed cipher (async API — the sync trio is deprecated in
 * Electron 45, removed in 46). Wired into the server credential store and the
 * hub-token store at boot, and exposed to the side-car over the capability
 * bridge (`AppDeps.credentialCipher`). Returns null when safeStorage isn't
 * exported (non-Electron runtime) so the store falls back to plaintext (test/dev).
 */
export function getSafeStorageCipher(): CredentialCipher | null {
  const safeStorage = (electron as unknown as { safeStorage?: Electron.SafeStorage }).safeStorage
  if (!safeStorage) return null
  return {
    isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encryptString: (secret) => safeStorage.encryptStringAsync(secret),
    decryptString: (encrypted) => safeStorage.decryptStringAsync(encrypted)
  }
}
