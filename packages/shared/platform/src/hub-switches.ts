/**
 * The per-hub switches that replaced `SLAYZONE_MODE`.
 *
 * There is no "hosted mode". Each hub declares what it does through explicit
 * `0|1` switches; the defaults are exactly what the desktop app's own hub does,
 * so a hub with nothing set behaves like that one:
 *
 *   SLAYZONE_HUB_REQUIRE_LOGIN        0   every client must sign in
 *   SLAYZONE_HUB_ENABLE_PASSWORD      1   email + password sign-in
 *   SLAYZONE_HUB_ENABLE_SSO           0   Entra OIDC sign-in
 *   SLAYZONE_HUB_ENABLE_PROCESSES     1   hub-local processes / automation commands
 *   SLAYZONE_HUB_ENABLE_INTEGRATIONS  1   Linear / GitHub connect + sync
 *   SLAYZONE_HUB_ENABLE_TELEMETRY     1   third-party telemetry about this hub's data: off,
 *                                         an app whose OWN data lives here (the web UI, an app
 *                                         with it as default hub) sends nothing — no PostHog,
 *                                         no Convex leaderboard / feedback; any other connected
 *                                         app withholds the events about its tasks + projects
 *
 * Env wins over `<ROOT>/hub.config.json` (`standalone-config.ts` seeds env from the
 * file before anything reads it), so this module only ever reads env. Anything
 * other than `0` / `1` is a boot refusal (rule B4): a switch that silently fell back
 * to its default on a typo (`REQUIRE_LOGIN=true`) would fail OPEN.
 *
 * This module only parses, validates and reports the switches. Processes,
 * integrations and password off are enforced through `hub-switch-refusal.ts` (password
 * also in hub-auth and the hub's REST gate, T-10); SSO lives in hub-auth (T-09).
 * Telemetry off: the web shell's CSP drops the PostHog origins (hub
 * `security-headers.ts`), the hub never starts a Convex sign-in
 * (`assertHubConvexSignInUrl`), and clients read the switch from `hub.describe` /
 * `/health`: for their home hub they start neither PostHog nor Convex, for another hub
 * they drop the events about its data (`@slayzone/telemetry`, `trackForHub`).
 *
 * Lean leaf (no imports) so the CLI and computer bundles can use it without the
 * platform barrel.
 *
 * @module platform/hub-switches
 */

/** Env var of each switch. */
export const HUB_SWITCH_ENV = {
  requireLogin: 'SLAYZONE_HUB_REQUIRE_LOGIN',
  enablePassword: 'SLAYZONE_HUB_ENABLE_PASSWORD',
  enableSso: 'SLAYZONE_HUB_ENABLE_SSO',
  enableProcesses: 'SLAYZONE_HUB_ENABLE_PROCESSES',
  enableIntegrations: 'SLAYZONE_HUB_ENABLE_INTEGRATIONS',
  enableTelemetry: 'SLAYZONE_HUB_ENABLE_TELEMETRY'
} as const

export type HubSwitchKey = keyof typeof HUB_SWITCH_ENV

/** The resolved state of every switch. */
export type HubSwitches = Record<HubSwitchKey, boolean>

/** Defaults = the desktop app's hub. */
export const HUB_SWITCH_DEFAULTS: Readonly<HubSwitches> = {
  requireLogin: false,
  enablePassword: true,
  enableSso: false,
  enableProcesses: true,
  enableIntegrations: true,
  enableTelemetry: true
}

/**
 * SSO settings (not switches, but `ENABLE_SSO=1` is refused without them — B7).
 *
 * The hub proves itself to Entra with a CERTIFICATE (a signed client assertion,
 * `private_key_jwt`), never a client secret: the two paths name a PEM certificate and
 * its PEM private key (one file holding both may be named twice). Paths only — the key
 * itself never travels through env, `hub.config.json` or a log line.
 */
export const HUB_SSO_ENV = {
  tenantId: 'SLAYZONE_HUB_SSO_TENANT_ID',
  clientId: 'SLAYZONE_HUB_SSO_CLIENT_ID',
  /** PEM certificate registered on the Entra app (its SHA-256 thumbprint goes in each assertion). Env only. */
  certPath: 'SLAYZONE_HUB_SSO_CERT_PATH',
  /** PEM private key of that certificate (RSA, unencrypted). Env only. */
  keyPath: 'SLAYZONE_HUB_SSO_KEY_PATH',
  /** `0|1`, default `1`: refuse a sign-in whose ID token's `amr` does not contain `mfa`. */
  requireMfa: 'SLAYZONE_HUB_SSO_REQUIRE_MFA'
} as const

/**
 * The client-secret setting T-02 reserved. Never read: Entra sign-in uses the
 * certificate above (B7 refuses a hub that still sets it, so nobody believes a secret
 * is in use). Kept in {@link HUB_PROCESS_ENV} so a parent still clears it.
 */
export const RETIRED_HUB_SSO_CLIENT_SECRET_ENV = 'SLAYZONE_HUB_SSO_CLIENT_SECRET'

/** The names the hub reads for where it listens / how others reach it. */
export const HUB_ADDRESS_ENV = {
  /** Where the hub LISTENS. Renamed from `SLAYZONE_HUB_ADDRESS`, which now only
   *  means "the hub to connect to" on a computer / `slay`. */
  listen: 'SLAYZONE_HUB_LISTEN_ADDRESS',
  /** How OTHER machines reach the hub (`host[:port]`, no scheme). */
  public: 'SLAYZONE_HUB_PUBLIC_ADDRESS',
  /** Signing key of hub-auth. */
  authSecret: 'SLAYZONE_HUB_AUTH_SECRET'
} as const

/** The old hub-side name of {@link HUB_ADDRESS_ENV.listen}. */
export const LEGACY_HUB_LISTEN_ENV = 'SLAYZONE_HUB_ADDRESS'

/**
 * Days a hub keeps session content (T-23, hub `session-retention.ts`): a non-negative
 * integer, `0` = kept until deleted. Not a switch, so not `0|1`; anything that is not a
 * non-negative integer refuses boot (rule B16). Env only, no `hub.config.json` key.
 */
export const HUB_SESSION_RETENTION_DAYS_ENV = 'SLAYZONE_HUB_SESSION_RETENTION_DAYS'

/** Extra browser origins the hub accepts on its websocket (comma-separated). */
export const HUB_ALLOWED_WEB_ORIGINS_ENV = 'SLAYZONE_HUB_ALLOWED_WEB_ORIGINS'

/**
 * The front ends whose `X-Forwarded-For` the hub believes: comma-separated IPs and
 * CIDRs (T-22, `@slayzone/platform/client-address`). Unset = trust nobody.
 */
export const HUB_TRUSTED_PROXIES_ENV = 'SLAYZONE_HUB_TRUSTED_PROXIES'

/**
 * The Convex deployment this hub starts GitHub sign-in against (`host[:port]`, no
 * scheme — loopback → http, else https). Unset, or `SLAYZONE_HUB_ENABLE_TELEMETRY=0`, = no
 * Convex sign-in on this hub. The hub never POSTs to a Convex URL a client names (T-99);
 * see `hub-convex.ts`.
 */
export const HUB_CONVEX_ADDRESS_ENV = 'SLAYZONE_HUB_CONVEX_ADDRESS'

/**
 * Every variable that configures a hub PROCESS. A parent that spawns a hub with its
 * own values (the desktop app's sidecar) must clear all of these first: whatever it
 * inherited from wherever IT was launched (a task terminal, a shell profile, a CI
 * job) would otherwise reach the hub, and a stray one is not harmless — an inherited
 * public address makes the hub "reachable" with login off (B1 refuses), an inherited
 * non-0/1 switch trips B4, an inherited auth secret silently changes who can sign in.
 *
 * Includes {@link LEGACY_HUB_LISTEN_ENV}: on a hub it is the retired listen name (B5),
 * while its dial-side meaning belongs to a computer / `slay`, never to a hub.
 *
 * Includes {@link HUB_SESSION_RETENTION_DAYS_ENV}: an inherited period would start
 * deleting the desktop user's own session history.
 */
export const HUB_PROCESS_ENV: readonly string[] = [
  ...Object.values(HUB_SWITCH_ENV),
  ...Object.values(HUB_SSO_ENV),
  RETIRED_HUB_SSO_CLIENT_SECRET_ENV,
  ...Object.values(HUB_ADDRESS_ENV),
  LEGACY_HUB_LISTEN_ENV,
  HUB_ALLOWED_WEB_ORIGINS_ENV,
  HUB_TRUSTED_PROXIES_ENV,
  HUB_SESSION_RETENTION_DAYS_ENV,
  HUB_CONVEX_ADDRESS_ENV
]

/** Thrown for a malformed switch value (rule B4). */
export class HubSwitchValueError extends Error {
  constructor(
    readonly variable: string,
    readonly value: string
  ) {
    super(
      `[slayzone] ${variable} must be 0 or 1, got '${value}'. ` +
        `Switches take exactly 0 (off) or 1 (on) — not true/false/yes/no.`
    )
    this.name = 'HubSwitchValueError'
  }
}

/**
 * Parse one switch value. `undefined` (unset) → `undefined`; anything but exactly
 * `0` / `1` — including a blank string — throws {@link HubSwitchValueError}.
 */
export function parseSwitchValue(variable: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  if (raw === '1') return true
  if (raw === '0') return false
  throw new HubSwitchValueError(variable, raw)
}

/**
 * Resolve every switch from `env`, applying {@link HUB_SWITCH_DEFAULTS}.
 * Throws on the first malformed value (B4), naming the variable.
 */
export function resolveHubSwitches(env: NodeJS.ProcessEnv = process.env): HubSwitches {
  const out: HubSwitches = { ...HUB_SWITCH_DEFAULTS }
  for (const key of Object.keys(HUB_SWITCH_ENV) as HubSwitchKey[]) {
    const parsed = parseSwitchValue(HUB_SWITCH_ENV[key], env[HUB_SWITCH_ENV[key]])
    if (parsed !== undefined) out[key] = parsed
  }
  return out
}

/**
 * Does THIS hub process require login? Lenient on purpose (`=== '1'`, no throw):
 * for code that runs INSIDE a hub that has already passed boot validation (B4), or
 * that asks the question of its own env (MCP env builder), where a throw has no
 * useful place to land.
 */
export function isHubLoginRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HUB_SWITCH_ENV.requireLogin] === '1'
}

export interface HubSsoSettings {
  tenantId?: string
  clientId?: string
  certPath?: string
  keyPath?: string
  /** {@link HUB_SSO_ENV.requireMfa}; on unless set to exactly `0`. */
  requireMfa: boolean
}

/**
 * Read the SSO settings from env; blank counts as unset. A `REQUIRE_MFA` value other
 * than `0` / `1` throws {@link HubSwitchValueError} (rule B4), like a switch.
 */
export function resolveHubSso(env: NodeJS.ProcessEnv = process.env): HubSsoSettings {
  const pick = (name: string): string | undefined => {
    const v = env[name]?.trim()
    return v ? v : undefined
  }
  const out: HubSsoSettings = {
    requireMfa: parseSwitchValue(HUB_SSO_ENV.requireMfa, env[HUB_SSO_ENV.requireMfa]) ?? true
  }
  const tenantId = pick(HUB_SSO_ENV.tenantId)
  const clientId = pick(HUB_SSO_ENV.clientId)
  const certPath = pick(HUB_SSO_ENV.certPath)
  const keyPath = pick(HUB_SSO_ENV.keyPath)
  if (tenantId) out.tenantId = tenantId
  if (clientId) out.clientId = clientId
  if (certPath) out.certPath = certPath
  if (keyPath) out.keyPath = keyPath
  return out
}

/** Default of {@link HUB_SESSION_RETENTION_DAYS_ENV} = the desktop app's hub: no sweep. */
export const HUB_SESSION_RETENTION_DEFAULT_DAYS = 0

/**
 * Read {@link HUB_SESSION_RETENTION_DAYS_ENV}. Unset → the default (off). Anything but
 * decimal digits — blank, `-1`, `90d`, `1.5`, ` 90` — is not a period, and neither is a
 * number past `Number.MAX_SAFE_INTEGER`; the caller refuses boot (B16) on `ok: false`.
 * Exact like the switches: a value that silently fell back to "off" on a typo would keep
 * content the operator meant to delete.
 */
export function readHubSessionRetentionDays(
  env: NodeJS.ProcessEnv = process.env
): { ok: true; days: number } | { ok: false; message: string } {
  const raw = env[HUB_SESSION_RETENTION_DAYS_ENV]
  if (raw === undefined) return { ok: true, days: HUB_SESSION_RETENTION_DEFAULT_DAYS }
  const days = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (Number.isSafeInteger(days)) return { ok: true, days }
  return {
    ok: false,
    message:
      `[slayzone] ${HUB_SESSION_RETENTION_DAYS_ENV} must be a whole number of days (0 = keep ` +
      `session content until it is deleted), got '${raw}'.`
  }
}
