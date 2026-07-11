/**
 * Hub target resolution — lets the CLI talk to a remote SlayZone hub instead
 * of the local app's HTTP server.
 *
 * Precedence:
 *   1. `SLAYZONE_HUB_URL` / `SLAYZONE_HUB_TOKEN` environment variables
 *   2. `hub.json` in the CLI state dir (written by `slay hub set-url`)
 *   3. null — legacy behavior (local port discovery in db.ts, untouched)
 *
 * With no env vars and no hub.json the CLI behaves exactly as before.
 */
import fs from 'fs'
import path from 'path'
import { getDataDir } from './db'

export interface HubTarget {
  baseUrl: string
  token: string | null
}

interface HubFileConfig {
  url: string
  token?: string
}

const HUB_CONFIG_FILENAME = 'hub.json'

export function getHubConfigPath(): string {
  return path.join(getDataDir(), HUB_CONFIG_FILENAME)
}

/**
 * Normalize + validate a hub URL. Returns `origin + pathname` with trailing
 * slashes stripped from the pathname (query/fragment are dropped — they are
 * meaningless on a base URL), or null when it is not a valid http(s) URL.
 */
export function normalizeHubUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // Strip trailing slashes from the pathname only — stripping on the raw
  // string would corrupt a query/fragment that happens to end in '/'.
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

function readHubFile(): HubFileConfig | null {
  const configPath = getHubConfigPath()
  let rawText: string
  try {
    rawText = fs.readFileSync(configPath, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Warning: could not read hub config at ${configPath} — using local app.`)
    }
    return null
  }
  try {
    const parsed: unknown = JSON.parse(rawText)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('not an object')
    }
    const config = parsed as HubFileConfig
    if (typeof config.url !== 'string' || config.url.trim() === '') {
      throw new Error('missing url')
    }
    return config
  } catch {
    console.error(`Warning: ignoring invalid hub config at ${configPath} — using local app.`)
    return null
  }
}

/**
 * Resolve the hub target, or null when no hub is configured (legacy local-app
 * behavior). An invalid `SLAYZONE_HUB_URL` is a hard error (exit 1) — the user
 * explicitly asked for a hub, silently falling back to the local app would be
 * surprising. A corrupt hub.json only warns and falls back.
 */
export function resolveHubTarget(): HubTarget | null {
  const envUrl = process.env.SLAYZONE_HUB_URL
  // SLAYZONE_HUB_TOKEN semantics: unset → the file token may apply; set →
  // it wins, and set-but-empty means "explicitly no token" (never falls
  // back to the file token) — consistent across both branches below.
  const envToken = process.env.SLAYZONE_HUB_TOKEN
  if (envUrl && envUrl.trim() !== '') {
    const baseUrl = normalizeHubUrl(envUrl)
    if (!baseUrl) {
      console.error(`Invalid SLAYZONE_HUB_URL (expected http(s) URL): ${envUrl}`)
      process.exit(1)
    }
    // Env URL never picks up the file token — hub.json may target a different hub.
    return { baseUrl, token: envToken || null }
  }

  const file = readHubFile()
  if (file) {
    const baseUrl = normalizeHubUrl(file.url)
    if (!baseUrl) {
      console.error(
        `Warning: ignoring invalid hub URL in ${getHubConfigPath()} — using local app.`
      )
      return null
    }
    const fileToken = typeof file.token === 'string' && file.token !== '' ? file.token : null
    return { baseUrl, token: envToken !== undefined ? envToken || null : fileToken }
  }

  return null
}

/**
 * Write hub.json with owner-only permissions (0600). Returns the config path.
 * Expects a pre-normalized URL (see normalizeHubUrl).
 *
 * Note: the 0600 mode is best-effort on Windows — POSIX permission bits are
 * not enforced there (chmod only toggles the read-only flag); the file is
 * still protected by the user-profile directory ACLs.
 */
export function writeHubConfig(url: string, token?: string | null): string {
  const configPath = getHubConfigPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const payload: HubFileConfig = token ? { url, token } : { url }
  fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync only applies mode on create — enforce on overwrite too.
  fs.chmodSync(configPath, 0o600)
  return configPath
}

/** Remove hub.json. Returns false when no config existed. */
export function removeHubConfig(): boolean {
  try {
    fs.unlinkSync(getHubConfigPath())
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}
