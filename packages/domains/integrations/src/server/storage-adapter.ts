/**
 * Storage adapter for at-rest encryption of integration credentials
 * (GitHub/Jira/Linear API tokens).
 *
 * Two impls in Phase 1:
 *   - ElectronStorageAdapter (electron/storage-adapter-electron.ts) — wraps
 *     Electron `safeStorage` (OS keychain).
 *   - NodeStorageAdapter (./storage-adapter-node.ts) — AES-256-GCM, key from
 *     SLAYZONE_SECRET env or auto-generated getDataRoot()/.secret file.
 *
 * Factory selects at boot via `selectStorageAdapter()`. Server pkg (Phase 3)
 * uses NodeStorageAdapter; Electron app uses ElectronStorageAdapter.
 */
export interface StorageAdapter {
  /** Whether encryption is available (e.g. keychain unlocked). Throw on use if false. */
  isAvailable(): boolean
  encrypt(secret: string): Buffer
  decrypt(encrypted: Buffer): string
}

let _adapter: StorageAdapter | null = null

/** Boot wiring: app/main or @slayzone/server sets this once. */
export function setStorageAdapter(a: StorageAdapter): void {
  _adapter = a
}

export function getStorageAdapter(): StorageAdapter | null {
  return _adapter
}
