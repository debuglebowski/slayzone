import { createHash } from 'crypto'

/**
 * Chrome's extension ID for a manifest `key` (base64 DER public key): the first 128
 * bits of its SHA-256, each hex digit mapped 0-f → a-p. Lets the browser panel tell
 * that an extension imported from another browser is the same extension as one
 * installed from the Chrome Web Store, before loading it.
 */
export function extensionIdFromManifestKey(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('')
}
