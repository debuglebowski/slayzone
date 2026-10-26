import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import { isLoopbackAuthority } from '@slayzone/platform'
import type { HubEntry } from '@slayzone/types'

/**
 * Pre-boot server-mode config (slice 7).
 *
 * Deliberately a tiny JSON file (`<clientRoot>/client.boot.json`) and NOT a
 * settings-table row: in remote mode the settings DB lives on the remote
 * server, so reading the mode from the DB at boot would be circular. This file
 * is the only thing the main process consults before deciding whether to start
 * the local backend at all.
 *
 * Kept free of electron imports so it stays unit-testable under plain vitest.
 */

export type ServerMode = 'local' | 'remote'

/** Stable sentinel id for the co-located sidecar hub. */
export const LOCAL_HUB_ID = 'local'
/**
 * Fixed id assigned to a pre-multi-hub single-remote server when it is migrated
 * into the `hubs[]` registry. Stable so the migration is idempotent.
 */
export const LEGACY_REMOTE_HUB_ID = 'remote-legacy'

export type BootConfig = {
  server_mode: ServerMode
  /** Canonical ws(s)://host[:port]/trpc URL — normalized on write. */
  remote_server_url?: string
  /**
   * Multi-hub federation gate. When true, the client connects to the
   * always-running co-located local hub PLUS every remote hub in `hubs[]` at
   * once and merges their projects. Default off (absent) → single-hub behavior
   * (local, or one legacy remote) is byte-identical. Flipping it requires a
   * relaunch (embedded-server start/skip is decided at boot), like `server_mode`.
   */
  multi_hub?: boolean
  /**
   * Persisted REMOTE hubs only. The local hub is never stored here — it is
   * always synthesized by `resolveHubRegistry` so "local is always present" is
   * a structural guarantee that no file edit can break. Absent until the user
   * adds a second hub.
   */
  hubs?: HubEntry[]
  /** Id of the hub new projects land on. Synthesized when absent. */
  default_hub_id?: string
}

export type BootSettingsPatch = {
  server_mode?: ServerMode
  remote_server_url?: string
  multi_hub?: boolean
  /** Replaces the persisted remote-hub list wholesale (local is never listed). */
  hubs?: HubEntry[]
  default_hub_id?: string
}

export type HealthProbeResult = {
  ok: boolean
  /** Canonical ws(s) URL derived from the probed input — present when input parsed. */
  normalizedUrl?: string
  error?: string
  /**
   * Whether the probed hub gates its client API on a bearer token. UNDEFINED
   * when the hub is too old to report it (pre-`authRequired` /health) — callers
   * must treat undefined as "unknown", not as "no auth needed".
   */
  authRequired?: boolean
  /**
   * How the hub lets people sign in, from its `/health` switches: `sso` = Entra (the
   * app signs in through the browser, device sign-in), `password` = email + password.
   * Undefined when the hub is too old to report switches (treat as password-only).
   */
  signIn?: { sso: boolean; password: boolean }
}

export type HubLoginResult = { ok: true; token: string } | { ok: false; error: string }

// `client.<what>.json`: the desktop client's own files, next to `client.config.json`.
const FILE_NAME = 'client.boot.json'
/** What this file was called before the rename (`boot-config.json`). Read-only. */
const LEGACY_FILE_NAME = 'boot-config.json'

/**
 * Canonicalizes user input to `ws(s)://host[:port]/trpc`. Accepts http(s) and
 * ws(s) schemes (http→ws, https→wss), forces the path, strips query + hash.
 * Returns null when the input is not a usable URL.
 */
export function normalizeRemoteUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const scheme =
    url.protocol === 'http:' || url.protocol === 'ws:'
      ? 'ws'
      : url.protocol === 'https:' || url.protocol === 'wss:'
        ? 'wss'
        : null
  if (!scheme || !url.hostname) return null
  return `${scheme}://${url.host}/trpc`
}

/** Maps the canonical ws URL to the server's GET /health endpoint. */
export function toHealthUrl(wsUrl: string): string {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/health'
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Validates + normalizes one persisted REMOTE hub entry. Returns null for any
 * shape we won't trust (missing id/url, unnormalizable url, wrong kind) so a
 * hand-edited or partially-written file can't inject a broken hub. The local
 * hub is never persisted, so `kind` must be `'remote'` here. A `fingerprint` an
 * older release kept per hub (a certificate pin) is dropped: remote hubs are
 * verified the normal way, and the next write no longer carries it.
 */
function sanitizeHubEntry(raw: unknown): HubEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.kind !== 'remote') return null
  if (typeof o.id !== 'string' || !o.id) return null
  if (typeof o.url !== 'string') return null
  const url = normalizeRemoteUrl(o.url)
  if (!url) return null
  const entry: HubEntry = {
    id: o.id,
    kind: 'remote',
    label: typeof o.label === 'string' && o.label ? o.label : o.id,
    url
  }
  return entry
}

/**
 * Reads the pre-boot config. Any missing/corrupt/invalid state falls back to local.
 *
 * Looks for the file in three places, first readable one wins:
 *   1. `<dir>/client.boot.json`   — current name and location
 *   2. `<dir>/boot-config.json`   — the old name, in the client dir (beta.14+)
 *   3. `<legacyDir>/boot-config.json` — the old name in the hub root (older betas)
 *
 * The fallbacks are READ-ONLY and never copy — the same stance `cli-state.ts`
 * takes, and for the same reason generalized: moving a file as a side effect of an
 * unrelated boot is the kind of thing that should be deliberate. The next
 * `writeBootSettings` (any server-mode / hubs / default-hub change) lands in the
 * new location and completes the move naturally. For THIS file that is also the
 * safer mechanic: it is read at the most fragile moment in boot, and a failed copy
 * there would brick startup.
 */
export function readBootConfig(dir: string, legacyDir?: string): BootConfig {
  const candidates = [join(dir, FILE_NAME), join(dir, LEGACY_FILE_NAME)]
  if (legacyDir) candidates.push(join(legacyDir, LEGACY_FILE_NAME))
  let parsed: unknown
  let found = false
  for (const file of candidates) {
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
      found = true
      break
    } catch {
      /* missing / unreadable → try the next location */
    }
  }
  if (!found) return { server_mode: 'local' }
  if (typeof parsed !== 'object' || parsed === null) return { server_mode: 'local' }
  const obj = parsed as Record<string, unknown>
  if (obj.server_mode !== 'local' && obj.server_mode !== 'remote') {
    return { server_mode: 'local' }
  }
  const config: BootConfig = { server_mode: obj.server_mode }
  if (typeof obj.remote_server_url === 'string') {
    const normalized = normalizeRemoteUrl(obj.remote_server_url)
    if (normalized) config.remote_server_url = normalized
  }
  // Surface the multi-hub fields ONLY when present and
  // well-formed, so a single-hub file reads back exactly as before (the existing
  // toEqual round-trip tests stay green) and the byte-identical default holds.
  if (obj.multi_hub === true) config.multi_hub = true
  if (Array.isArray(obj.hubs)) {
    const hubs = obj.hubs.map(sanitizeHubEntry).filter((h): h is HubEntry => h !== null)
    if (hubs.length > 0) config.hubs = hubs
  }
  if (typeof obj.default_hub_id === 'string' && obj.default_hub_id) {
    config.default_hub_id = obj.default_hub_id
  }
  return config
}

/**
 * Merges a partial update into the existing config and writes it atomically
 * (tmp + rename — a crash mid-write must never leave a half-written file that
 * `readBootConfig` would then silently coerce to local). Throws on an
 * unnormalizable URL so callers surface the validation error instead of
 * persisting garbage.
 */
export function writeBootSettings(
  dir: string,
  patch: BootSettingsPatch,
  legacyDir?: string
): BootConfig {
  // Merge over whatever is currently EFFECTIVE, legacy included, so the first
  // write after the relocation carries the old settings forward instead of
  // resetting them to defaults.
  const next: BootConfig = { ...readBootConfig(dir, legacyDir) }
  if (patch.server_mode !== undefined) next.server_mode = patch.server_mode
  if (patch.remote_server_url !== undefined) {
    const normalized = normalizeRemoteUrl(patch.remote_server_url)
    if (!normalized) throw new Error(`Invalid remote server URL: ${patch.remote_server_url}`)
    next.remote_server_url = normalized
  }
  if (patch.multi_hub !== undefined) {
    if (patch.multi_hub) next.multi_hub = true
    else delete next.multi_hub
  }
  if (patch.hubs !== undefined) {
    // Round-trip every entry through the sanitizer so a bad url throws here
    // (surfaced to the caller) rather than being silently dropped on next read.
    const sanitized = patch.hubs.map((h) => {
      const clean = sanitizeHubEntry(h)
      if (!clean) throw new Error(`Invalid hub entry: ${JSON.stringify(h)}`)
      return clean
    })
    if (sanitized.length > 0) next.hubs = sanitized
    else delete next.hubs
  }
  if (patch.default_hub_id !== undefined) {
    if (patch.default_hub_id) next.default_hub_id = patch.default_hub_id
    else delete next.default_hub_id
  }
  mkdirSync(dir, { recursive: true })
  const target = join(dir, FILE_NAME)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, target)
  return next
}

/** The synthesized local-hub entry (never persisted; url injected at runtime). */
export function localHubEntry(): HubEntry {
  return { id: LOCAL_HUB_ID, kind: 'local', label: 'Local' }
}

/**
 * Resolves the effective hub registry the client should connect to — the single
 * source of truth for "which hubs exist", derived purely from the pre-boot
 * config (no live port knowledge; the caller injects the local hub's runtime
 * ws url).
 *
 * `server_mode` is AUTHORITATIVE for whether a local hub runs — it literally
 * means "run a local backend" (`local` = yes, `remote` = no). That single
 * meaning holds whether or not multi_hub is on; the "Run a local hub" toggle in
 * the Hubs UI just writes `server_mode`. This replaces the old Server tab.
 *
 * Discipline (keeps single-hub users byte-identical):
 *  - multi_hub OFF + local mode  → exactly `[local]` (today: one local sidecar).
 *  - multi_hub OFF + remote mode → exactly `[remote-legacy]`, NO local (today: a
 *    single remote server, sidecar never spawned).
 *  - multi_hub ON → `[local?, ...persisted remotes]`. Local is included IFF
 *    `server_mode === 'local'` (the toggle); a lingering legacy
 *    `remote_server_url` not yet migrated into `hubs[]` is folded in defensively
 *    as `remote-legacy` so no configured hub is dropped. A config with local off
 *    AND no remotes is nonsensical (no hub at all) — we fall back to `[local]`
 *    so the app always has a working hub.
 */
export function resolveHubRegistry(config: BootConfig): HubEntry[] {
  if (config.multi_hub !== true) {
    if (config.server_mode === 'remote' && config.remote_server_url) {
      return [
        {
          id: LEGACY_REMOTE_HUB_ID,
          kind: 'remote',
          label: 'Remote',
          url: config.remote_server_url
        }
      ]
    }
    return [localHubEntry()]
  }
  const remotes: HubEntry[] = config.hubs ? [...config.hubs] : []
  // Fold a not-yet-migrated single-remote url into the list so flipping the flag
  // before the management UI migrates it never loses the configured remote.
  if (
    config.remote_server_url &&
    !remotes.some((h) => h.url === config.remote_server_url || h.id === LEGACY_REMOTE_HUB_ID)
  ) {
    remotes.push({
      id: LEGACY_REMOTE_HUB_ID,
      kind: 'remote',
      label: 'Remote',
      url: config.remote_server_url
    })
  }
  // Local presence is governed by server_mode (the "Run a local hub" toggle).
  // Guard: never return an empty registry — if local is off but there are no
  // remotes, keep local so the app has a hub to talk to.
  const includeLocal = config.server_mode !== 'remote' || remotes.length === 0
  return includeLocal ? [localHubEntry(), ...remotes] : remotes
}

/**
 * Resolves the default hub id (where new projects land). Prefers the persisted
 * `default_hub_id` when it still names a hub in the registry; otherwise falls
 * back to the first registry entry (local when multi_hub is on, the sole remote
 * in legacy remote mode). The Phase-5 management UI always writes an explicit
 * `default_hub_id`, so the fallback only bites a raw hand-edited file.
 */
export function resolveDefaultHubId(
  config: BootConfig,
  registry = resolveHubRegistry(config)
): string {
  if (config.default_hub_id && registry.some((h) => h.id === config.default_hub_id)) {
    return config.default_hub_id
  }
  return registry[0]?.id ?? LOCAL_HUB_ID
}

/**
 * Probes a remote server's GET /health from the MAIN process. Runs here (not
 * a renderer fetch) because the renderer CSP floor only allows loopback WS
 * origins and /health sets no CORS headers — and because pre-TrpcProvider
 * surfaces (RemoteConfigScreen) need it before any client exists.
 */
export function probeRemoteHealth(rawUrl: string, timeoutMs = 5000): Promise<HealthProbeResult> {
  const normalizedUrl = normalizeRemoteUrl(rawUrl)
  if (!normalizedUrl) {
    return Promise.resolve({
      ok: false,
      error: 'Invalid URL — use http(s):// or ws(s)://host[:port]'
    })
  }
  // Hub scheme rule (hubUrlFromAddr): loopback → ws, any other host → wss. A
  // plaintext non-loopback hub could never connect (the renderer CSP floor is
  // TLS-only off-loopback), so refuse it here — the gate every add flow goes
  // through — with the reason, instead of letting it fail silently later.
  const parsed = new URL(normalizedUrl)
  if (parsed.protocol === 'ws:' && !isLoopbackAuthority(parsed.host)) {
    return Promise.resolve({
      ok: false,
      normalizedUrl,
      error: `Non-local hubs need TLS — use wss://${parsed.host} (put the hub behind an HTTPS front end)`
    })
  }
  const healthUrl = toHealthUrl(normalizedUrl)
  const get = healthUrl.startsWith('https:') ? https.get : http.get
  return new Promise((resolve) => {
    const req = get(healthUrl, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        // /health bodies are tiny; cap defensively against a misconfigured URL
        // pointing at something that streams forever.
        if (body.length < 4096) body += chunk
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, normalizedUrl, error: `Server answered HTTP ${res.statusCode}` })
          return
        }
        try {
          const parsed = JSON.parse(body) as {
            ok?: boolean
            authRequired?: boolean
            switches?: { enableSso?: unknown; enablePassword?: unknown }
          }
          // `authRequired` is served to every caller (see hub/src/health.ts), so
          // it survives an off-box probe — which is the case that matters, since
          // an off-box hub is the one that gates. Absent on older hubs → left
          // undefined rather than coerced to false.
          const authRequired =
            typeof parsed.authRequired === 'boolean' ? parsed.authRequired : undefined
          const signIn = parsed.switches
            ? {
                sso: parsed.switches.enableSso === true,
                password: parsed.switches.enablePassword !== false
              }
            : undefined
          if (parsed.ok === true) resolve({ ok: true, normalizedUrl, authRequired, signIn })
          else resolve({ ok: false, normalizedUrl, error: 'Server is not ready', authRequired })
        } catch {
          resolve({ ok: false, normalizedUrl, error: 'Not a SlayZone server (bad /health body)' })
        }
      })
    })
    req.on('error', (err) =>
      resolve({ ok: false, normalizedUrl, error: String(err.message ?? err) })
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, normalizedUrl, error: `Health check timed out after ${timeoutMs}ms` })
    })
  })
}

/** Maps the canonical ws URL to the hub's BetterAuth email sign-in endpoint. */
function toAuthSignInUrl(wsUrl: string): string {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/api/auth/sign-in/email'
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Signs in to a remote hub's BetterAuth (email+password) from the MAIN process
 * and returns a bearer token. Runs here (not a renderer fetch) for the same
 * reasons as `probeRemoteHealth` — CSP + no CORS — and so the main-process cert
 * pin applies to the wss host. The bearer plugin returns the token in the
 * `set-auth-token` response header; we also accept a `token` field in the body.
 * The caller persists it via the safeStorage token store.
 */
export function hubLogin(
  rawUrl: string,
  email: string,
  password: string,
  timeoutMs = 10000
): Promise<HubLoginResult> {
  const normalizedUrl = normalizeRemoteUrl(rawUrl)
  if (!normalizedUrl) return Promise.resolve({ ok: false, error: 'Invalid hub URL' })
  const signInUrl = toAuthSignInUrl(normalizedUrl)
  const payload = JSON.stringify({ email, password })
  const request = signInUrl.startsWith('https:') ? https.request : http.request
  return new Promise((resolve) => {
    const req = request(
      signInUrl,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          if (body.length < 65536) body += chunk
        })
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            resolve({ ok: false, error: `Sign-in failed (HTTP ${res.statusCode})` })
            return
          }
          // Bearer plugin: token in the `set-auth-token` header. Fallback: body.
          const header = res.headers['set-auth-token']
          const headerToken = Array.isArray(header) ? header[0] : header
          if (headerToken) {
            resolve({ ok: true, token: headerToken })
            return
          }
          try {
            const parsed = JSON.parse(body) as { token?: string }
            if (parsed.token) resolve({ ok: true, token: parsed.token })
            else resolve({ ok: false, error: 'Hub returned no token' })
          } catch {
            resolve({ ok: false, error: 'Bad sign-in response' })
          }
        })
      }
    )
    req.on('error', (err) => resolve({ ok: false, error: String(err.message ?? err) }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: `Sign-in timed out after ${timeoutMs}ms` })
    })
    req.write(payload)
    req.end()
  })
}

// ------------------------------------------------------------------ device sign-in
//
// A hub with Entra sign-in (T-14): the app never takes a password for it. It asks the
// hub for a device code (RFC 8628), opens the hub's `/device` page in the SYSTEM
// browser — where the person signs in through Entra with MFA and approves — and polls
// for the bearer. Same flow as `slay hub login`; only remote hubs ever get here (the
// local hub has login off and no sign-in at all). Plain `http(s).request` like
// `hubLogin`: no Fetch Metadata, so better-auth treats it as the non-browser client it is.

/** The client id the desktop app identifies as (the hub's approval page names it). */
export const DESKTOP_DEVICE_CLIENT_ID = 'slayzone-desktop'

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export type HubDeviceCode = {
  deviceCode: string
  /** As the person reads it, `ABCD-EFGH`. */
  userCode: string
  /** The page to open (with the code filled in). */
  verificationUri: string
  expiresInSec: number
  intervalSec: number
}

/** Maps the canonical ws URL to a path on the hub's http(s) origin. */
function toHubHttpUrl(wsUrl: string, pathname: string): string {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  return url.toString()
}

function postJsonMain(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body)
  const request = url.startsWith('https:') ? https.request : http.request
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          if (text.length < 65536) text += chunk
        })
        res.on('end', () => {
          let json: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(text) as unknown
            if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
          } catch {
            // Not JSON: the status says what happened.
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)))
    req.end(payload)
  })
}

/** Ask a hub for a device code. */
export async function hubDeviceCode(
  rawUrl: string,
  timeoutMs = 10000
): Promise<({ ok: true } & HubDeviceCode) | { ok: false; error: string }> {
  const normalizedUrl = normalizeRemoteUrl(rawUrl)
  if (!normalizedUrl) return { ok: false, error: 'Invalid hub URL' }
  let res: { status: number; json: Record<string, unknown> }
  try {
    res = await postJsonMain(
      toHubHttpUrl(normalizedUrl, '/api/auth/device/code'),
      { client_id: DESKTOP_DEVICE_CLIENT_ID },
      timeoutMs
    )
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const j = res.json
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const deviceCode = str(j.device_code)
  const userCode = str(j.user_code)
  const page = str(j.verification_uri_complete) || str(j.verification_uri)
  if (res.status !== 200 || !deviceCode || !userCode || !page) {
    const why = str(j.error_description)
    return {
      ok: false,
      error: `The hub did not start a sign-in (HTTP ${res.status})${why ? `: ${why}` : ''}`
    }
  }
  return {
    ok: true,
    deviceCode,
    userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
    verificationUri: page,
    expiresInSec: typeof j.expires_in === 'number' ? j.expires_in : 600,
    intervalSec: typeof j.interval === 'number' ? Math.max(5, j.interval) : 5
  }
}

/**
 * True when the hub's approval page is on the hub's own host — the only page the app
 * opens in the browser by itself. Anything else is shown for the person to judge.
 */
export function isHubOwnPage(rawUrl: string, page: string): boolean {
  const normalizedUrl = normalizeRemoteUrl(rawUrl)
  if (!normalizedUrl) return false
  try {
    const target = new URL(page)
    return (
      (target.protocol === 'https:' || target.protocol === 'http:') &&
      target.host === new URL(normalizedUrl).host
    )
  } catch {
    return false
  }
}

/**
 * Poll until the person approved (→ the bearer), denied, or the code expired. RFC 8628
 * §3.5: wait `interval` between polls, 5s more after each `slow_down`. A network error
 * is retried until the code's own expiry. `signal` stops it (the dialog was closed).
 */
export async function waitForHubDeviceToken(
  rawUrl: string,
  code: Pick<HubDeviceCode, 'deviceCode' | 'expiresInSec' | 'intervalSec'>,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {}
): Promise<HubLoginResult> {
  const normalizedUrl = normalizeRemoteUrl(rawUrl)
  if (!normalizedUrl) return { ok: false, error: 'Invalid hub URL' }
  const tokenUrl = toHubHttpUrl(normalizedUrl, '/api/auth/device/token')
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let intervalMs = code.intervalSec * 1000
  const deadline = Date.now() + code.expiresInSec * 1000
  while (Date.now() < deadline + intervalMs) {
    await sleep(intervalMs)
    if (opts.signal?.aborted) return { ok: false, error: 'Sign-in cancelled' }
    let res: { status: number; json: Record<string, unknown> }
    try {
      res = await postJsonMain(
        tokenUrl,
        {
          grant_type: DEVICE_GRANT,
          device_code: code.deviceCode,
          client_id: DESKTOP_DEVICE_CLIENT_ID
        },
        10000
      )
    } catch {
      continue
    }
    const { error, access_token: token } = res.json
    if (res.status === 200 && typeof token === 'string' && token) return { ok: true, token }
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      intervalMs += 5000
      continue
    }
    if (error === 'access_denied') return { ok: false, error: 'Sign-in was denied in the browser' }
    if (error === 'expired_token') return { ok: false, error: 'The sign-in code expired' }
    if (res.json.code === 'ACCOUNT_DISABLED') {
      return { ok: false, error: 'This account is disabled on the hub' }
    }
    const why =
      typeof res.json.error_description === 'string' ? `: ${res.json.error_description}` : ''
    return { ok: false, error: `Sign-in failed (HTTP ${res.status})${why}` }
  }
  return { ok: false, error: 'The sign-in code expired' }
}
