import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CloudTtsProvider } from '@slayzone/voice/shared'
import type { TokenCipher } from './hub-tokens'

/**
 * Bring-your-own-key cloud voice keys, on THIS device only: encrypted with the OS
 * keychain (safeStorage), in `<client root>/client.voice-keys.json`. Main decrypts
 * them for the voice engine per session; the renderer can set or clear a key and ask
 * which are set, never read one back. Never synced to a hub.
 */

const FILE_NAME = 'client.voice-keys.json'

function read(dir: string): Partial<Record<CloudTtsProvider, string>> {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, FILE_NAME), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<CloudTtsProvider, string>) : {}
  } catch {
    return {}
  }
}

function write(dir: string, data: Partial<Record<CloudTtsProvider, string>>): void {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, FILE_NAME)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, target)
}

/** Store (or clear, when `key` is empty) a provider's key, encrypted. */
export async function setVoiceKey(
  dir: string,
  cipher: TokenCipher | null,
  provider: CloudTtsProvider,
  key: string
): Promise<void> {
  let blob: string | null = null
  const trimmed = key.trim()
  if (trimmed) {
    if (!(await cipher?.isEncryptionAvailable())) {
      throw new Error('Key not stored: this system has no secure storage available')
    }
    blob = (await cipher!.encryptString(trimmed)).toString('base64')
  }
  // Encrypt before reading: the read-merge-write below stays synchronous.
  const data = read(dir)
  if (blob) data[provider] = blob
  else delete data[provider]
  write(dir, data)
}

/** Which providers have a key stored (never the keys). */
export function voiceKeyStatus(dir: string): Partial<Record<CloudTtsProvider, boolean>> {
  const out: Partial<Record<CloudTtsProvider, boolean>> = {}
  for (const provider of Object.keys(read(dir)) as CloudTtsProvider[]) out[provider] = true
  return out
}

/** Every stored key, decrypted (for the voice engine only). Undecryptable ones are skipped. */
export async function readVoiceKeys(
  dir: string,
  cipher: TokenCipher | null
): Promise<Partial<Record<CloudTtsProvider, string>>> {
  const out: Partial<Record<CloudTtsProvider, string>> = {}
  if (!cipher) return out
  for (const [provider, blob] of Object.entries(read(dir)) as Array<[CloudTtsProvider, string]>) {
    try {
      out[provider] = (await cipher.decryptString(Buffer.from(blob, 'base64'))).result
    } catch {
      // OS key changed or file edited: treat as unset.
    }
  }
  return out
}
