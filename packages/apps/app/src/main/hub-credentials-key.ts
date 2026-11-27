import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import type { TokenCipher } from './hub-tokens'

/**
 * The desktop hub's integration-credentials key (decision D1).
 *
 * The desktop's hub runs on the shared dev auth secret, so it cannot derive a key the
 * way a standalone hub does. Instead this app generates 256 bits once per install,
 * keeps them at `<hubRoot>/hub.credentials-key.enc` wrapped with Electron safeStorage
 * (the macOS Keychain, DPAPI, libsecret), and hands the unwrapped value to its hub
 * over an inherited pipe, never through the environment (sidecar-server-supervisor
 * `secretPayload`, review M1).
 *
 * Without safeStorage (Linux with no keyring) the key is kept unwrapped in the same
 * 0600 file — still better than the `plain:` rows such hubs wrote before — and wrapped
 * on the first boot where safeStorage works.
 *
 * A key that can never be read here (review H2: the Keychain item was reset or access
 * denied, the file came back on another machine, the file is damaged) is SET ASIDE as
 * `hub.credentials-key.enc.unreadable-<ts>` — kept byte for byte, never deleted — and a
 * new key is minted, so reconnecting an integration works again; rows under the old key
 * ask for Reconnect. Every boot tries the set-aside files again: one that unwraps (the
 * keychain came back) is handed to the hub as a PREVIOUS key, and its rows are read and
 * re-encrypted under the new one.
 *
 * Transient — safeStorage unavailable right now for a wrapped key — is not "never":
 * nothing is moved, the hub runs this session without a key (`current: null`).
 */
export const HUB_CREDENTIALS_KEY_FILE = 'hub.credentials-key.enc'
const SET_ASIDE_MARK = '.unreadable-'

type KeyFile = { v: 1; wrap: 'safeStorage' | 'none'; data: string }

export interface HubCredentialsKeys {
  /** The key to encrypt with; null = none this session (safeStorage unavailable). */
  current: string | null
  /** Set-aside keys that unwrapped again: read-only, their rows re-encrypt. */
  previous: string[]
}

function syncDir(dir: string): void {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Write, fsync, rename, fsync the directory (L4): a key must survive a power loss. */
function writeAtomic(path: string, file: KeyFile): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(file))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, path)
  syncDir(dirname(path))
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

function parse(raw: string): KeyFile | null {
  try {
    const file = JSON.parse(raw) as KeyFile
    return file?.v === 1 && typeof file.data === 'string' ? file : null
  } catch {
    return null
  }
}

type Unwrapped =
  | { kind: 'key'; secret: string; rewrap: boolean }
  | { kind: 'unavailable' }
  | { kind: 'unreadable'; why: string }

async function unwrap(file: KeyFile | null, cipher: TokenCipher | null): Promise<Unwrapped> {
  if (!file) return { kind: 'unreadable', why: 'not a key file' }
  if (file.wrap === 'none') return { kind: 'key', secret: file.data, rewrap: true }
  const c = await usable(cipher)
  if (!c) return { kind: 'unavailable' }
  try {
    const { result, shouldReEncrypt } = await c.decryptString(Buffer.from(file.data, 'base64'))
    return { kind: 'key', secret: result, rewrap: shouldReEncrypt }
  } catch (err) {
    return { kind: 'unreadable', why: String(err) }
  }
}

async function mint(path: string, cipher: TokenCipher | null, log: (l: string) => void) {
  const secret = randomBytes(32).toString('base64url')
  const file = await wrap(secret, cipher)
  if (file.wrap === 'none')
    log('[hub-credentials-key] safeStorage unavailable — key kept unwrapped (0600)')
  writeAtomic(path, file)
  return secret
}

/** Set-aside keys that unwrap now (keychain back): the hub's previous keys. */
async function recoverSetAside(hubRoot: string, cipher: TokenCipher | null): Promise<string[]> {
  let names: string[]
  try {
    names = fs
      .readdirSync(hubRoot)
      .filter((n) => n.startsWith(`${HUB_CREDENTIALS_KEY_FILE}${SET_ASIDE_MARK}`))
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names.sort()) {
    let raw: string
    try {
      raw = fs.readFileSync(join(hubRoot, name), 'utf8')
    } catch {
      continue
    }
    const got = await unwrap(parse(raw), cipher)
    if (got.kind === 'key') out.push(got.secret)
  }
  return out
}

export async function loadHubCredentialsKeys(
  hubRoot: string,
  cipher: TokenCipher | null,
  log: (line: string) => void = (line) => console.warn(line)
): Promise<HubCredentialsKeys> {
  const path = join(hubRoot, HUB_CREDENTIALS_KEY_FILE)
  let raw: string | null = null
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`[hub-credentials-key] cannot read ${path}: ${String(err)} — hub runs without a key`)
      return { current: null, previous: [] }
    }
  }

  let current: string
  if (raw === null) {
    current = await mint(path, cipher, log)
  } else {
    const file = parse(raw)
    const got = await unwrap(file, cipher)
    if (got.kind === 'unavailable') {
      log(
        '[hub-credentials-key] key is safeStorage-wrapped but safeStorage is unavailable — no key this session'
      )
      return { current: null, previous: [] }
    }
    if (got.kind === 'unreadable') {
      const aside = `${path}${SET_ASIDE_MARK}${new Date().toISOString().replace(/[:.]/g, '-')}`
      fs.renameSync(path, aside)
      syncDir(hubRoot)
      log(
        `[hub-credentials-key] key cannot be read (${got.why}) — kept as ${aside}, new key minted; ` +
          'integrations saved under the old key ask to reconnect'
      )
      current = await mint(path, cipher, log)
    } else {
      current = got.secret
      if (got.rewrap && (await usable(cipher))) {
        try {
          writeAtomic(path, await wrap(current, cipher))
        } catch {
          /* retried next boot */
        }
      }
    }
  }
  const previous = (await recoverSetAside(hubRoot, cipher)).filter((k) => k !== current)
  return { current, previous }
}

/**
 * The keys as the hub supervisor asks for them at every spawn (L6). Unwrapping can sit
 * on an OS keychain prompt; the hub must not wait for it — a blank window until the
 * user answers. `ready()` resolves with what is known after at most `timeoutMs`
 * (null = start this hub without a key, logged); a key that arrives later is handed
 * to the next start (`payload()`, asked at each spawn).
 */
export function createHubCredentialsKeySource(
  load: () => Promise<HubCredentialsKeys>,
  opts: { timeoutMs?: number; log?: (line: string) => void } = {}
): { ready: () => Promise<string | null>; payload: () => string | null } {
  const log = opts.log ?? ((line: string) => console.warn(line))
  let payload: string | null = null
  const loaded = load().then(
    (keys) => {
      if (keys.current) payload = JSON.stringify({ current: keys.current, previous: keys.previous })
      return payload
    },
    (err: unknown) => {
      log(`[hub-credentials-key] failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  )
  const timeoutMs = opts.timeoutMs ?? 10_000
  return {
    ready: () =>
      Promise.race([
        loaded,
        new Promise<string | null>((resolve) => {
          const t = setTimeout(() => {
            if (payload === null) {
              log(
                `[hub-credentials-key] the OS keychain has not answered in ${timeoutMs}ms — the hub starts without its key; integrations can't be saved until the next start`
              )
            }
            resolve(payload)
          }, timeoutMs)
          t.unref?.()
        })
      ]),
    payload: () => payload
  }
}
