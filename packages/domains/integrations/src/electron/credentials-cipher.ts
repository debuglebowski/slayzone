import electron from 'electron'

/**
 * Mirrors Electron's ASYNC safeStorage API (the sync trio is deprecated in Electron
 * 45, removed in 46). Ciphertext written by the old sync `encryptString` stays
 * decryptable by `decryptStringAsync`.
 */
export interface SafeStorageCipher {
  isEncryptionAvailable: () => Promise<boolean>
  encryptString: (secret: string) => Promise<Buffer>
  /** `shouldReEncrypt` — the OS key rotated (or a stronger one is available). */
  decryptString: (encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
}

/**
 * Electron safeStorage-backed cipher. Used by the desktop for its own secrets (the
 * hub-token store, the wrapped hub credentials key) and exposed to the side-car over
 * the capability bridge (`AppDeps.credentialCipher`), where the hub uses ONLY its
 * decrypt, for integration credentials an older desktop hub wrote with safeStorage.
 * Returns null when safeStorage isn't exported (non-Electron runtime).
 */
export function getSafeStorageCipher(): SafeStorageCipher | null {
  const safeStorage = (electron as unknown as { safeStorage?: Electron.SafeStorage }).safeStorage
  if (!safeStorage) return null
  return {
    isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encryptString: (secret) => safeStorage.encryptStringAsync(secret),
    decryptString: (encrypted) => safeStorage.decryptStringAsync(encrypted)
  }
}
