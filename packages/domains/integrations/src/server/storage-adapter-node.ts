import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getDataRoot } from '@slayzone/platform'
import type { StorageAdapter } from './storage-adapter'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const SECRET_FILE = '.secret'

function resolveSecret(): Buffer {
  const env = process.env.SLAYZONE_SECRET
  if (env && env.length > 0) {
    return crypto.createHash('sha256').update(env, 'utf8').digest()
  }
  const file = path.join(getDataRoot(), SECRET_FILE)
  if (!fs.existsSync(file)) {
    const bytes = crypto.randomBytes(32)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    return crypto.createHash('sha256').update(bytes).digest()
  }
  const bytes = fs.readFileSync(file)
  return crypto.createHash('sha256').update(bytes).digest()
}

/**
 * Node StorageAdapter using AES-256-GCM. Key is SHA-256 of either the
 * `SLAYZONE_SECRET` env var, or 32 random bytes auto-generated at
 * `${getDataRoot()}/.secret` on first boot (file mode 0600).
 *
 * **Not keychain-strength.** Anyone w/ disk + env access decrypts. Defense
 * in depth, not full security. Operator must protect the data dir + env.
 */
export class NodeStorageAdapter implements StorageAdapter {
  private readonly key: Buffer

  constructor() {
    this.key = resolveSecret()
  }

  isAvailable(): boolean {
    return this.key.length === 32
  }

  encrypt(secret: string): Buffer {
    const iv = crypto.randomBytes(IV_LEN)
    const cipher = crypto.createCipheriv(ALGO, this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, ciphertext])
  }

  decrypt(encrypted: Buffer): string {
    if (encrypted.length < IV_LEN + TAG_LEN) {
      throw new Error('NodeStorageAdapter: encrypted blob too short')
    }
    const iv = encrypted.subarray(0, IV_LEN)
    const tag = encrypted.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const ciphertext = encrypted.subarray(IV_LEN + TAG_LEN)
    const decipher = crypto.createDecipheriv(ALGO, this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }
}
