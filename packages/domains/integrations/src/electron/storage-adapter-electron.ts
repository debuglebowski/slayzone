import { safeStorage } from 'electron'
import type { StorageAdapter } from '../server/storage-adapter'

/** Wraps Electron `safeStorage` (OS keychain). Default in Electron mode. */
export class ElectronStorageAdapter implements StorageAdapter {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  encrypt(secret: string): Buffer {
    if (!this.isAvailable()) {
      throw new Error('OS secure credential storage is unavailable on this machine')
    }
    return safeStorage.encryptString(secret)
  }

  decrypt(encrypted: Buffer): string {
    if (!this.isAvailable()) {
      throw new Error('OS secure credential storage is unavailable on this machine')
    }
    return safeStorage.decryptString(encrypted)
  }
}
