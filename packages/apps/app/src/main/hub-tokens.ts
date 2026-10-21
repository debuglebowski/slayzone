import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Multi-hub federation — per-hub bearer token store (main process).
 *
 * Tokens are secrets and span hubs, so they live neither in a hub DB (a hub may
 * be down / is the wrong trust domain) nor in the plaintext boot-config. They
 * are encrypted with Electron `safeStorage` and persisted to a sibling file
 * `<clientRoot>/client.tokens.json` ({ hubId → base64(safeStorage ciphertext) }).
 *
 * Kept electron-free at the type level: the caller injects a `TokenCipher`
 * (Electron `safeStorage`) so this module stays unit-testable + so a missing
 * cipher (safeStorage unavailable) degrades to "no tokens" rather than crashing.
 */

export interface TokenCipher {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (cipher: Buffer) => string
}

const FILE_NAME = 'client.tokens.json'
/** What this file was called before the rename (`hub-tokens.json`). Read-only. */
const LEGACY_FILE_NAME = 'hub-tokens.json'

let cipher: TokenCipher | null = null

/** Inject the Electron safeStorage cipher (main boot). Absent → tokens disabled. */
export function setHubTokenCipher(c: TokenCipher | null): void {
  cipher = c
}

/**
 * Reads the token map from the first readable of:
 *   1. `<dir>/client.tokens.json`        — current name and location
 *   2. `<dir>/hub-tokens.json`           — the old name, in the client dir (beta.14+)
 *   3. `<legacyDir>/hub-tokens.json`     — the old name in the hub root (older betas)
 *
 * READ-ONLY fallbacks, never a copy — this file holds bearer tokens, and
 * relocating credentials as a side effect of an unrelated boot is exactly what
 * `cli-state.ts` refuses to do. The next `setHubToken` (i.e. the next deliberate
 * sign-in) writes to the new location.
 */
function readRaw(dir: string, legacyDir?: string): Record<string, string> {
  const candidates = [join(dir, FILE_NAME), join(dir, LEGACY_FILE_NAME)]
  if (legacyDir) candidates.push(join(legacyDir, LEGACY_FILE_NAME))
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
    } catch {
      /* missing / corrupt → try the next location */
    }
  }
  return {}
}

function writeRaw(dir: string, data: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, FILE_NAME)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, target)
}

/**
 * Store (or clear, when token is empty) a hub's bearer token, encrypted.
 *
 * Merges over what is currently EFFECTIVE, old locations included, so the first
 * sign-in after the move carries every other hub's token forward instead of writing
 * a file that holds only this one (which silently signed the user out of the rest).
 */
export function setHubToken(dir: string, hubId: string, token: string, legacyDir?: string): void {
  const data = readRaw(dir, legacyDir)
  if (!token) {
    delete data[hubId]
  } else if (cipher?.isEncryptionAvailable()) {
    data[hubId] = cipher.encryptString(token).toString('base64')
  } else {
    // No cipher — refuse to persist plaintext secrets silently.
    throw new Error('hub token not stored — safeStorage encryption unavailable')
  }
  writeRaw(dir, data)
}

/** Decrypt a hub's token, or null when absent / undecryptable. */
export function getHubToken(dir: string, hubId: string): string | null {
  const enc = readRaw(dir)[hubId]
  if (!enc || !cipher?.isEncryptionAvailable()) return null
  try {
    return cipher.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

/** All hubId → token pairs the renderer needs to open authed connections. */
export function getAllHubTokens(dir: string, legacyDir?: string): Record<string, string> {
  const enc = readRaw(dir, legacyDir)
  if (!cipher?.isEncryptionAvailable()) return {}
  const out: Record<string, string> = {}
  for (const [hubId, blob] of Object.entries(enc)) {
    try {
      out[hubId] = cipher.decryptString(Buffer.from(blob, 'base64'))
    } catch {
      /* skip undecryptable */
    }
  }
  return out
}
