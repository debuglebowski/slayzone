import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * The hub's own credential cipher. Integration tokens are encrypted by the process
 * that stores them, under a key that process holds, so a standalone hub stops
 * keeping them in plaintext and the desktop hub stops borrowing Electron safeStorage
 * over the capability bridge for every read.
 *
 * Stored value: `hub1:<kid>:<base64(iv | tag | ciphertext)>`
 *   - AES-256-GCM, a random 12-byte IV per write, a 16-byte tag.
 *   - AAD = the settings key the value is stored under, so a row copied onto another
 *     connection's key fails to decrypt instead of serving the wrong account's token.
 *   - `kid` = 8 bytes of HKDF(key), hex. It tells "a key this hub does not hold" apart
 *     from "corrupt", and makes a key change a routine re-encrypt: the old key goes in
 *     `previous`, every read under it re-encrypts with `current`.
 *
 * The key material is never the AES key itself: the AES key and the kid are both
 * HKDF outputs under distinct labels, so the kid (stored next to every value) says
 * nothing about the encryption key.
 */

export const HUB_CREDENTIAL_PREFIX = 'hub1:'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const ENC_LABEL = 'slayzone-hub/credential-cipher/enc/v1'
const KID_LABEL = 'slayzone-hub/credential-cipher/kid/v1'

/** The keys a hub can decrypt with. Writes always use `current`. */
export interface CredentialKeyRing {
  current: Buffer
  previous?: readonly Buffer[]
}

export type HubCredentialErrorCode = 'wrong-key' | 'corrupt'

export class HubCredentialError extends Error {
  constructor(
    readonly code: HubCredentialErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'HubCredentialError'
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`[slayzone] a credential key must be ${KEY_BYTES} bytes, got ${key.length}`)
  }
}

function derive(key: Buffer, label: string, bytes: number): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), label, bytes))
}

/** The key's id as stored in every value it encrypts: 16 hex chars. */
export function credentialKeyId(key: Buffer): string {
  assertKey(key)
  return derive(key, KID_LABEL, 8).toString('hex')
}

export function isHubCredential(value: string): boolean {
  return value.startsWith(HUB_CREDENTIAL_PREFIX)
}

export function encryptHubCredential(ring: CredentialKeyRing, aad: string, secret: string): string {
  const key = ring.current
  assertKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', derive(key, ENC_LABEL, KEY_BYTES), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
  return `${HUB_CREDENTIAL_PREFIX}${credentialKeyId(key)}:${payload}`
}

/**
 * Decrypt a `hub1:` value. `shouldReEncrypt` = it was written under a previous key.
 * Throws {@link HubCredentialError}: `wrong-key` when no key in the ring has its kid,
 * `corrupt` for anything malformed or failing authentication.
 */
export function decryptHubCredential(
  ring: CredentialKeyRing,
  aad: string,
  value: string
): { result: string; shouldReEncrypt: boolean } {
  if (!isHubCredential(value)) throw new HubCredentialError('corrupt', 'not a hub credential')
  const rest = value.slice(HUB_CREDENTIAL_PREFIX.length)
  const sep = rest.indexOf(':')
  const kid = sep < 0 ? '' : rest.slice(0, sep)
  const payload = sep < 0 ? Buffer.alloc(0) : Buffer.from(rest.slice(sep + 1), 'base64')
  if (!/^[0-9a-f]{16}$/.test(kid) || payload.length < IV_BYTES + TAG_BYTES) {
    throw new HubCredentialError('corrupt', 'malformed hub credential')
  }
  const keys = [ring.current, ...(ring.previous ?? [])]
  const key = keys.find((k) => credentialKeyId(k) === kid)
  if (!key) {
    throw new HubCredentialError(
      'wrong-key',
      'credential was encrypted with a key this hub does not hold'
    )
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      derive(key, ENC_LABEL, KEY_BYTES),
      payload.subarray(0, IV_BYTES)
    )
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    const result = Buffer.concat([
      decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final()
    ]).toString('utf8')
    return { result, shouldReEncrypt: key !== ring.current }
  } catch {
    throw new HubCredentialError('corrupt', 'hub credential failed authentication')
  }
}
