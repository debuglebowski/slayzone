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

/** Electron's async safeStorage shape (the sync trio is deprecated in Electron 45). */
export interface TokenCipher {
  isEncryptionAvailable: () => Promise<boolean>
  encryptString: (plain: string) => Promise<Buffer>
  /** `shouldReEncrypt` — the OS key rotated: re-encrypt `result` and persist it. */
  decryptString: (cipher: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
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
 * sign-in) writes to the new location. `current` says whether the map came from
 * location 1 — only then may a key-rotation re-encrypt write it back.
 */
function readRaw(
  dir: string,
  legacyDir?: string
): { data: Record<string, string>; current: boolean } {
  const candidates = [join(dir, FILE_NAME), join(dir, LEGACY_FILE_NAME)]
  if (legacyDir) candidates.push(join(legacyDir, LEGACY_FILE_NAME))
  for (const [i, file] of candidates.entries()) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object')
        return { data: parsed as Record<string, string>, current: i === 0 }
    } catch {
      /* missing / corrupt → try the next location */
    }
  }
  return { data: {}, current: false }
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
 * Encrypts BEFORE reading so the read-merge-write stays synchronous — no await
 * between them, so a concurrent set can't be lost.
 */
export async function setHubToken(
  dir: string,
  hubId: string,
  token: string,
  legacyDir?: string
): Promise<void> {
  let blob: string | null = null
  if (token) {
    if (!(await cipher?.isEncryptionAvailable())) {
      // No cipher — refuse to persist plaintext secrets silently.
      throw new Error('hub token not stored — safeStorage encryption unavailable')
    }
    blob = (await cipher!.encryptString(token)).toString('base64')
  }
  const { data } = readRaw(dir, legacyDir)
  if (blob) data[hubId] = blob
  else delete data[hubId]
  writeRaw(dir, data)
}

/** Decrypt a hub's token, or null when absent / undecryptable. */
export async function getHubToken(dir: string, hubId: string): Promise<string | null> {
  return (await decryptAll(dir, undefined, hubId))[hubId] ?? null
}

/** All hubId → token pairs the renderer needs to open authed connections. */
export async function getAllHubTokens(
  dir: string,
  legacyDir?: string
): Promise<Record<string, string>> {
  return decryptAll(dir, legacyDir)
}

/**
 * Decrypts every (or just `only`) token, skipping undecryptable ones. Tokens whose
 * key rotated are re-encrypted and written back — but only into the current file
 * (old names are read-only), and only where the blob is still the one decrypted,
 * so a sign-in that landed meanwhile is never clobbered.
 */
async function decryptAll(
  dir: string,
  legacyDir?: string,
  only?: string
): Promise<Record<string, string>> {
  const c = cipher
  if (!c || !(await c.isEncryptionAvailable())) return {}
  const { data, current } = readRaw(dir, legacyDir)
  const out: Record<string, string> = {}
  const rotated = new Map<string, { prev: string; next: string }>()
  for (const [hubId, blob] of Object.entries(data)) {
    if (only !== undefined && hubId !== only) continue
    try {
      const { result, shouldReEncrypt } = await c.decryptString(Buffer.from(blob, 'base64'))
      out[hubId] = result
      if (shouldReEncrypt && current) {
        rotated.set(hubId, { prev: blob, next: (await c.encryptString(result)).toString('base64') })
      }
    } catch {
      /* skip undecryptable (or a failed re-encrypt — retried on the next read) */
    }
  }
  if (rotated.size > 0) writeBackRotated(dir, rotated)
  return out
}

/** Swap in re-encrypted blobs, compare-and-swap per hub against a fresh read. Best-effort. */
function writeBackRotated(dir: string, rotated: Map<string, { prev: string; next: string }>): void {
  const fresh = readRaw(dir)
  if (!fresh.current) return
  let changed = false
  for (const [hubId, { prev, next }] of rotated) {
    if (fresh.data[hubId] !== prev) continue
    fresh.data[hubId] = next
    changed = true
  }
  if (!changed) return
  try {
    writeRaw(dir, fresh.data)
  } catch {
    /* retried on the next read */
  }
}
