import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { TokenCipher } from './hub-tokens'

/**
 * The desktop hub's integration-credentials key (decision D1).
 *
 * The desktop's hub runs on the shared dev auth secret, so it cannot derive a key the
 * way a standalone hub does. Instead this app generates 256 bits once per install,
 * keeps them at `<hubRoot>/hub.credentials-key.enc` wrapped with Electron safeStorage
 * (the macOS Keychain, DPAPI, libsecret), and hands the unwrapped value to its hub as
 * `SLAYZONE_HUB_CREDENTIALS_SECRET` — secret-scoped in ENV_MANIFEST, so it never reaches
 * a terminal, the same exposure as SLAYZONE_DESKTOP_BRIDGE_TOKEN.
 *
 * Without safeStorage (Linux with no keyring) the key is kept unwrapped in the same
 * 0600 file — still better than the `plain:` rows such hubs wrote before — and wrapped
 * on the first boot where safeStorage works.
 *
 * An existing file is NEVER replaced by a new key: every stored credential is
 * encrypted under it. If it cannot be read or unwrapped (keychain reset, the file
 * restored on another machine) this returns null and the hub runs without a key: its
 * `hub1:` rows ask for Reconnect, and nothing is lost should the key come back.
 */
export const HUB_CREDENTIALS_KEY_FILE = 'hub.credentials-key.enc'

type KeyFile = { v: 1; wrap: 'safeStorage' | 'none'; data: string }

function writeAtomic(path: string, file: KeyFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(file))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

async function usable(cipher: TokenCipher | null): Promise<TokenCipher | null> {
  try {
    return cipher && (await cipher.isEncryptionAvailable()) ? cipher : null
  } catch {
    return null
  }
}

async function wrap(secret: string, cipher: TokenCipher | null): Promise<KeyFile> {
  const c = await usable(cipher)
  if (!c) return { v: 1, wrap: 'none', data: secret }
  return { v: 1, wrap: 'safeStorage', data: (await c.encryptString(secret)).toString('base64') }
}

export async function loadHubCredentialsSecret(
  hubRoot: string,
  cipher: TokenCipher | null,
  log: (line: string) => void = (line) => console.warn(line)
): Promise<string | null> {
  const path = join(hubRoot, HUB_CREDENTIALS_KEY_FILE)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`[hub-credentials-key] cannot read ${path}: ${String(err)} — hub runs without a key`)
      return null
    }
    const secret = randomBytes(32).toString('base64url')
    const file = await wrap(secret, cipher)
    if (file.wrap === 'none') {
      log('[hub-credentials-key] safeStorage unavailable — key kept unwrapped (0600)')
    }
    writeAtomic(path, file)
    return secret
  }

  let file: KeyFile
  try {
    file = JSON.parse(raw) as KeyFile
    if (file?.v !== 1 || typeof file.data !== 'string') throw new Error('unknown format')
  } catch (err) {
    log(`[hub-credentials-key] ${path} unreadable (${String(err)}) — hub runs without a key`)
    return null
  }

  if (file.wrap === 'none') {
    // Wrap it the first time safeStorage works. Best-effort: the key is valid either way.
    if (await usable(cipher)) {
      try {
        writeAtomic(path, await wrap(file.data, cipher))
      } catch {
        /* retried next boot */
      }
    }
    return file.data
  }

  const c = await usable(cipher)
  if (!c) {
    log('[hub-credentials-key] key is safeStorage-wrapped but safeStorage is unavailable')
    return null
  }
  try {
    const { result, shouldReEncrypt } = await c.decryptString(Buffer.from(file.data, 'base64'))
    if (shouldReEncrypt) {
      try {
        writeAtomic(path, await wrap(result, c))
      } catch {
        /* retried next boot */
      }
    }
    return result
  } catch (err) {
    log(`[hub-credentials-key] cannot unwrap the key (${String(err)}) — hub runs without a key`)
    return null
  }
}
