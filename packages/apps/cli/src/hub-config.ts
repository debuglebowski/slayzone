/**
 * Hub target resolution — lets the CLI talk to a remote SlayZone hub instead
 * of the local app's HTTP server.
 *
 * TWO KINDS OF COMMAND, TWO ANSWERS:
 *   - TASK commands — everything that goes through `api.ts` (tasks, artifacts, pty,
 *     …) — act on the data of the hub this shell belongs to.
 *     {@link resolveTaskCommandTarget}.
 *   - HUB commands — `hub users`, `hub computers`, `computer mint`, `computer ls` —
 *     act ON a hub, as an object of administration. {@link resolveHubCommandTarget}.
 *
 * They differ only in a TASK TERMINAL (`SLAYZONE_TASK_ID` set: a shell the app opened
 * for a task). That shell belongs to the hub that spawned it, which the spawning
 * computer names in `SLAYZONE_HUB_ADDRESS`. The stored target (`slay hub use` /
 * `hub login`) is the operator's choice of hub to WORK ON, not a statement about
 * where a task lives: when it applied to task commands, `slay hub login <remote>`
 * silently pointed every agent toolbox on the machine at the remote hub.
 *
 * Channels:
 *   - `--hub <name|port>` on the command line — resolved via hub-discovery in the
 *     root `preAction` hook, which calls {@link setHubOverride}. An explicit
 *     per-invocation flag has to beat the ambient env/config, or `slay --hub
 *     staging …` would silently hit whatever hub the shell was pointed at. Names a
 *     LOOPBACK hub only (discovery sweeps 127.0.0.1), and carries
 *     `SLAYZONE_HUB_TOKEN` if set — never the stored target's token, which belongs to
 *     whichever hub `hub use`/`hub login` targeted and need not be this one.
 *   - `SLAYZONE_HUB_ADDRESS` (+ `SLAYZONE_HUB_TOKEN`) environment variables —
 *     authority only (`host[:port]`); the http(s) scheme is DERIVED from the host
 *     (loopback → http, any other host → https). The env channel never carries a
 *     scheme, so it can't collide with the computer's ws(s):// reading of the same
 *     deployment (the retired `SLAYZONE_HUB_URL` bug). In a task terminal it is set
 *     by the computer that spawned it.
 *   - `hub-target[.dev].json` in the CLI's own state dir, `~/.slayzone/cli`
 *     (written by `slay hub use` / `slay hub login`; pre-move locations are still
 *     READ — see cli-state.ts) — a FULL http(s) url (an operator pointing at an
 *     external hub gives a complete url; not the env channel, so no scheme
 *     derivation). This is the channel that reaches a REMOTE hub, since `--hub`
 *     cannot.
 *   - `break-glass[.dev].json`, same dir (written by `slay hub break-glass start`) —
 *     a short-lived admin session, for hub commands only.
 *
 * Precedence, task commands:
 *   1. `--hub`
 *   2. `SLAYZONE_HUB_ADDRESS`
 *   3. the stored target — OUTSIDE a task terminal only
 *   4. null — the local app, found by probing its fixed port (api.ts); in a task
 *      terminal the responder must serve this terminal's `SLAYZONE_ROOT`, and with
 *      neither that nor an address api.ts refuses rather than guess.
 *
 * Precedence, hub commands:
 *   1. `--hub`
 *   2. a break-glass session that has not expired
 *   3. outside a task terminal: `SLAYZONE_HUB_ADDRESS`, then the stored target (a
 *      variable the user set wins over a file); inside one: the stored target, then
 *      `SLAYZONE_HUB_ADDRESS` (there the variable is the app's, not the user's)
 *   4. null — hub-request.ts falls back to the one hub running on this machine
 *
 * With no env vars and no stored files the CLI behaves exactly as before.
 */
import fs from 'fs'
import path from 'path'
import { hubUrlFromAddr, isBareAuthority } from '@slayzone/platform/hub-addr'
import { getBreakGlassPath, getHubTargetPath, legacyHubTargetPaths } from './cli-state'

export interface HubTarget {
  baseUrl: string
  token: string | null
}

/** Which channel a resolved target came from — `slay hub current` reports it. */
export type HubTargetSource = 'flag' | 'break-glass' | 'env' | 'file'

export interface ResolvedHubTarget extends HubTarget {
  source: HubTargetSource
}

interface HubFileConfig {
  url: string
  token?: string
}

/** A break-glass session as `slay hub break-glass start` stores it. */
export interface BreakGlassSession {
  url: string
  token: string
  /** As the hub reported it (ISO 8601). Unparseable → treated as not expired. */
  expiresAt: string
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
 * True in a shell the app opened for a task — `SLAYZONE_TASK_ID` is set. Such a
 * shell belongs to the hub that spawned it, whatever this machine has stored.
 */
export function isTaskTerminal(): boolean {
  return (process.env.SLAYZONE_TASK_ID ?? '').trim() !== ''
}

/**
 * Where the hub target is WRITTEN — the CLI's own state dir (see cli-state.ts).
 * Reads also consult the legacy locations; see {@link readHubFile}.
 */
export function getHubConfigPath(): string {
  return getHubTargetPath()
}

/** Where the break-glass session is stored — never the hub target's file. */
export function getBreakGlassSessionPath(): string {
  return getBreakGlassPath()
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

/**
 * Read a JSON object file. Null when absent; when unreadable or not an object, null
 * plus — if `label` names what it is — a warning saying it was ignored.
 */
function readJsonObject(file: string, label: string | null): Record<string, unknown> | null {
  let rawText: string
  try {
    rawText = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    if (label && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Warning: could not read ${label} at ${file} — ignoring it.`)
    }
    return null
  }
  try {
    const parsed: unknown = JSON.parse(rawText)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    if (label) console.error(`Warning: ignoring invalid ${label} at ${file}.`)
    return null
  }
}

function readHubFile(warn: boolean): HubFileConfig | null {
  const configPath = hubFilePathForRead()
  const config = readJsonObject(configPath, warn ? 'hub config' : null)
  if (!config) return null
  if (typeof config.url !== 'string' || config.url.trim() === '') {
    if (warn) console.error(`Warning: ignoring invalid hub config at ${configPath}.`)
    return null
  }
  return config as unknown as HubFileConfig
}

/**
 * The stored target (`slay hub use` / `hub login`), or null. A corrupt file only
 * warns (when `warn`) and reads as absent.
 */
function storedTarget(warn: boolean): ResolvedHubTarget | null {
  const file = readHubFile(warn)
  if (!file) return null
  const baseUrl = normalizeHubUrl(file.url)
  if (!baseUrl) {
    if (warn) console.error(`Warning: ignoring invalid hub URL in ${getHubConfigPath()}.`)
    return null
  }
  const fileToken = typeof file.token === 'string' && file.token !== '' ? file.token : null
  // SLAYZONE_HUB_TOKEN semantics: unset → the file token applies; set → it wins,
  // and set-but-empty means "explicitly no token".
  const envToken = process.env.SLAYZONE_HUB_TOKEN
  return { baseUrl, token: envToken !== undefined ? envToken || null : fileToken, source: 'file' }
}

/**
 * The `SLAYZONE_HUB_ADDRESS` target, or null when unset. An invalid value is a hard
 * error (exit 1) — the user (or the spawning computer) explicitly named a hub, and
 * silently falling back to another would be surprising.
 */
function envTarget(): ResolvedHubTarget | null {
  const envAddress = process.env.SLAYZONE_HUB_ADDRESS
  if (!envAddress || envAddress.trim() === '') return null
  const addr = envAddress.trim()
  // Must be authority ONLY (host[:port]) — reject a value that snuck in a
  // scheme or path. (A double-scheme like `http://http://x` still URL-parses,
  // so this explicit guard, not normalizeHubUrl, is what catches it.)
  const baseUrl = isBareAuthority(addr) ? normalizeHubUrl(hubUrlFromAddr(addr, 'http')) : null
  if (!baseUrl) {
    console.error(
      `Invalid SLAYZONE_HUB_ADDRESS (expected host[:port], no scheme/path): ${envAddress}`
    )
    process.exit(1)
  }
  // SLAYZONE_HUB_TOKEN set (empty = explicitly none) wins. Otherwise the stored
  // target's token — but ONLY when it was stored for this very hub: the stored target
  // may be a different hub, and its bearer must never be sent anywhere else. The
  // same-hub case is a computer whose operator ran `slay hub login <its hub>`: every
  // task terminal it opens for that hub names it here, and needs that sign-in.
  const envToken = process.env.SLAYZONE_HUB_TOKEN
  if (envToken !== undefined) return { baseUrl, token: envToken || null, source: 'env' }
  const stored = storedTarget(false)
  return { baseUrl, token: stored?.baseUrl === baseUrl ? stored.token : null, source: 'env' }
}

function flagTarget(): ResolvedHubTarget | null {
  return hubOverride ? { ...hubOverride, source: 'flag' } : null
}

/**
 * Where a TASK command goes, or null for the local app (api.ts probes for it).
 * See the module header for the precedence.
 */
export function resolveTaskCommandTarget(): ResolvedHubTarget | null {
  return flagTarget() ?? envTarget() ?? (isTaskTerminal() ? null : storedTarget(true))
}

/**
 * Where a HUB command goes, or null when nothing is configured (hub-request.ts
 * then looks for the one hub running here). See the module header for the
 * precedence.
 */
export function resolveHubCommandTarget(): ResolvedHubTarget | null {
  const flag = flagTarget()
  if (flag) return flag
  const session = readBreakGlassSession()
  if (session && !isBreakGlassExpired(session)) {
    return { baseUrl: session.url, token: session.token, source: 'break-glass' }
  }
  return isTaskTerminal()
    ? (storedTarget(true) ?? envTarget())
    : (envTarget() ?? storedTarget(true))
}

/**
 * Write a file only its owner can read (0600): the hub target and the break-glass
 * session both hold a bearer.
 *
 * Note: the 0600 mode is best-effort on Windows — POSIX permission bits are
 * not enforced there (chmod only toggles the read-only flag); the file is
 * still protected by the user-profile directory ACLs.
 */
function writePrivateJson(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync only applies mode on create — enforce on overwrite too.
  fs.chmodSync(file, 0o600)
}

/**
 * Write the stored hub target (0600). Returns the config path.
 * Expects a pre-normalized URL (see normalizeHubUrl).
 */
export function writeHubConfig(url: string, token?: string | null): string {
  const configPath = getHubConfigPath()
  const payload: HubFileConfig = token ? { url, token } : { url }
  writePrivateJson(configPath, payload)
  return configPath
}

/**
 * Remove the stored hub target. Returns false when no config existed.
 *
 * Clears the LEGACY locations too. Removing only the current path would leave a
 * pre-move file behind for {@link readHubFile}'s fallback to find, so `hub forget`
 * would report success and the very next command would still be pointed at the old
 * hub — with its bearer token still on disk.
 */
export function removeHubConfig(): boolean {
  let removed = false
  for (const target of [getHubConfigPath(), ...legacyHubTargetPaths()]) {
    if (unlinkIfPresent(target)) removed = true
  }
  return removed
}

/** The stored break-glass session, expired or not; null when absent or unreadable. */
export function readBreakGlassSession(): BreakGlassSession | null {
  const file = getBreakGlassSessionPath()
  const raw = readJsonObject(file, 'break-glass session')
  if (!raw) return null
  const { url, token, expiresAt } = raw
  const baseUrl = typeof url === 'string' ? normalizeHubUrl(url) : null
  if (!baseUrl || typeof token !== 'string' || token === '') {
    console.error(`Warning: ignoring invalid break-glass session at ${file}.`)
    return null
  }
  return { url: baseUrl, token, expiresAt: typeof expiresAt === 'string' ? expiresAt : '?' }
}

/** Past its `expiresAt`. A time the CLI cannot read is left to the hub to judge. */
export function isBreakGlassExpired(session: BreakGlassSession, now = Date.now()): boolean {
  const at = Date.parse(session.expiresAt)
  return !Number.isNaN(at) && at <= now
}

/** Store a break-glass session (0600). Returns its path. Leaves the hub target alone. */
export function writeBreakGlassSession(session: BreakGlassSession): string {
  const file = getBreakGlassSessionPath()
  writePrivateJson(file, session)
  return file
}

/** Forget the break-glass session. Returns false when none was stored. */
export function removeBreakGlassSession(): boolean {
  return unlinkIfPresent(getBreakGlassSessionPath())
}

function unlinkIfPresent(file: string): boolean {
  try {
    fs.unlinkSync(file)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return false
  }
}
