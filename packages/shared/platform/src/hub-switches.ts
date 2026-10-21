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
 *
 * Env wins over `<ROOT>/hub.config.json` (`standalone-config.ts` seeds env from the
 * file before anything reads it), so this module only ever reads env. Anything
 * other than `0` / `1` is a boot refusal (rule B4): a switch that silently fell back
 * to its default on a typo (`REQUIRE_LOGIN=true`) would fail OPEN.
 *
 * This task only parses, validates and reports the switches and wires
 * `REQUIRE_LOGIN`; enforcement of password / SSO / processes / integrations off
 * lives in later work.
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
  enableIntegrations: 'SLAYZONE_HUB_ENABLE_INTEGRATIONS'
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
  enableIntegrations: true
}

/** SSO settings (not switches, but `ENABLE_SSO=1` is refused without them — B7). */
export const HUB_SSO_ENV = {
  tenantId: 'SLAYZONE_HUB_SSO_TENANT_ID',
  clientId: 'SLAYZONE_HUB_SSO_CLIENT_ID',
  /** Secret — env only, never read from `hub.config.json`, never logged. */
  clientSecret: 'SLAYZONE_HUB_SSO_CLIENT_SECRET'
} as const

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

/** Extra browser origins the hub accepts on its websocket (comma-separated). */
export const HUB_ALLOWED_WEB_ORIGINS_ENV = 'SLAYZONE_HUB_ALLOWED_WEB_ORIGINS'

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
 */
export const HUB_PROCESS_ENV: readonly string[] = [
  ...Object.values(HUB_SWITCH_ENV),
  ...Object.values(HUB_SSO_ENV),
  ...Object.values(HUB_ADDRESS_ENV),
  LEGACY_HUB_LISTEN_ENV,
  HUB_ALLOWED_WEB_ORIGINS_ENV
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
  clientSecret?: string
}

/** Read the SSO settings from env; blank counts as unset. */
export function resolveHubSso(env: NodeJS.ProcessEnv = process.env): HubSsoSettings {
  const pick = (name: string): string | undefined => {
    const v = env[name]?.trim()
    return v ? v : undefined
  }
  const out: HubSsoSettings = {}
  const tenantId = pick(HUB_SSO_ENV.tenantId)
  const clientId = pick(HUB_SSO_ENV.clientId)
  const clientSecret = pick(HUB_SSO_ENV.clientSecret)
  if (tenantId) out.tenantId = tenantId
  if (clientId) out.clientId = clientId
  if (clientSecret) out.clientSecret = clientSecret
  return out
}
