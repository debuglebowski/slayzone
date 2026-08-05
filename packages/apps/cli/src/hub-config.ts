/**
 * Hub target resolution — lets the CLI talk to a remote SlayZone hub instead
 * of the local app's HTTP server.
 *
 * Precedence:
 *   0. `--hub <name|port>` on the command line — resolved via hub-discovery in
 *      the root `preAction` hook, which calls {@link setHubOverride}. An explicit
 *      per-invocation flag has to beat the ambient env/config, or `slay --hub
 *      staging …` would silently hit whatever hub the shell was pointed at.
 *      Names a LOOPBACK hub only (discovery sweeps 127.0.0.1), and carries
 *      `SLAYZONE_HUB_TOKEN` if set — never `cli-hub-target.json`'s token, which belongs to
 *      whichever hub `hub use`/`hub login` targeted and need not be this one.
 *   1. `SLAYZONE_HUB_ADDRESS` (+ `SLAYZONE_HUB_TOKEN`) environment variables —
 *      authority only (`host[:port]`); the http(s) scheme is DERIVED from
 *      SLAYZONE_MODE (local → http, remote → https). The env channel never
 *      carries a scheme, so it can't collide with the runner's ws(s):// reading
 *      of the same deployment (the retired `SLAYZONE_HUB_URL` bug).
 *   2. `hub-target[.dev].json` in the CLI's own state dir, `~/.slayzone/cli`
 *      (written by `slay hub use` / `slay hub login`; pre-move locations are still
 *      READ — see cli-state.ts) — a FULL http(s) url (an operator pointing at an external hub gives
 *      a complete url; not the env channel, so no scheme derivation). This is the
 *      channel that reaches a REMOTE hub, since `--hub` cannot.
 *   3. null — legacy behavior (local port discovery in db.ts, untouched)
 *
 * With no env vars and no cli-hub-target.json the CLI behaves exactly as before.
 */
import fs from 'fs'
import path from 'path'
import { hubUrlFromAddr, isBareAuthority } from '@slayzone/platform/hub-addr'
import { getHubTargetPath, legacyHubTargetPaths } from './cli-state'

export interface HubTarget {
  baseUrl: string
  token: string | null
}

interface HubFileConfig {
  url: string
  token?: string
}

/**
 * Target set by `--hub <name|port>` for THIS invocation only. Never persisted —
 * the flag is a one-shot redirect, unlike `slay hub use`.
 */
let hubOverride: HubTarget | null = null

/**
 * Point every subsequent API call at `target`. Called from the root command's
 * `preAction` hook once `--hub` has been resolved to a live hub.
 */
export function setHubOverride(target: HubTarget): void {
  hubOverride = target
}

/**
 * Where the hub target is WRITTEN — the CLI's own state dir (see cli-state.ts).
 * Reads also consult the legacy locations; see {@link readHubFile}.
 */
export function getHubConfigPath(): string {
  return getHubTargetPath()
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

/**
 * The hub-target file to READ: the current path, else the first legacy path that
 * still exists. Written configs only ever land at the current path, so this is a
 * one-way compatibility read for installs that configured a hub before the file
 * moved into the CLI's own state dir.
 */
function hubFilePathForRead(): string {
  const current = getHubConfigPath()
  if (fs.existsSync(current)) return current
  return legacyHubTargetPaths()[0] ?? current
}

function readHubFile(): HubFileConfig | null {
  const configPath = hubFilePathForRead()
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
 * behavior). An invalid `SLAYZONE_HUB_ADDRESS` is a hard error (exit 1) — the user
 * explicitly asked for a hub, silently falling back to the local app would be
 * surprising. A corrupt cli-hub-target.json only warns and falls back.
 *
 * `--hub` (see {@link setHubOverride}) wins over both.
 */
export function resolveHubTarget(): HubTarget | null {
  // `--hub` outranks everything: it names a hub for this one command.
  if (hubOverride) return hubOverride

  const envAddress = process.env.SLAYZONE_HUB_ADDRESS
  // SLAYZONE_HUB_TOKEN semantics: unset → the file token may apply; set →
  // it wins, and set-but-empty means "explicitly no token" (never falls
  // back to the file token) — consistent across both branches below.
  const envToken = process.env.SLAYZONE_HUB_TOKEN
  if (envAddress && envAddress.trim() !== '') {
    const addr = envAddress.trim()
    // Must be authority ONLY (host[:port]) — reject a value that snuck in a
    // scheme or path. (A double-scheme like `http://http://x` still URL-parses,
    // so this explicit guard, not normalizeHubUrl, is what catches it.)
    const baseUrl = isBareAuthority(addr) ? normalizeHubUrl(hubUrlFromAddr(addr, 'http')) : null
    if (!baseUrl) {
      console.error(`Invalid SLAYZONE_HUB_ADDRESS (expected host[:port], no scheme/path): ${envAddress}`)
      process.exit(1)
    }
    // Env address never picks up the file token — cli-hub-target.json may target a different hub.
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
 * Write cli-hub-target.json with owner-only permissions (0600). Returns the config path.
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

/**
 * Remove the stored hub target. Returns false when no config existed.
 *
 * Clears the LEGACY locations too. Removing only the current path would leave a
 * pre-move file behind for {@link readHubFile}'s fallback to find, so `hub logout`
 * would report success and the very next command would still be pointed at the old
 * hub — with its bearer token still on disk.
 */
export function removeHubConfig(): boolean {
  let removed = false
  for (const target of [getHubConfigPath(), ...legacyHubTargetPaths()]) {
    try {
      fs.unlinkSync(target)
      removed = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  return removed
}
