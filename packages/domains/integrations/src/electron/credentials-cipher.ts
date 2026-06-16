import electron from 'electron'
import type { SafeStorageCipher } from '../server/credentials'

/**
 * Electron safeStorage-backed cipher (synchronous). Wired into the server
 * credential store at boot via `setCredentialCipher`, and exposed to the side-car
 * over the capability bridge (`AppDeps.credentialCipher`). Returns null when
 * safeStorage isn't exported (non-Electron runtime) so the store falls back to
 * plaintext (test/dev).
 */
export function getSafeStorageCipher(): SafeStorageCipher | null {
  const safeStorage = (electron as unknown as { safeStorage?: SafeStorageCipher }).safeStorage
  return safeStorage ?? null
}
