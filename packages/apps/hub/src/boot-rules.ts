/**
 * The hub's boot rules: every check that refuses to start the hub, in the order the
 * plan draws them. A refusal throws BEFORE the hub opens its database or a port,
 * with a message that names the variable to change.
 *
 * Pure on purpose (env in, settings out, no I/O) so each rule has a unit test that
 * does not need `startServer`'s database, better-auth migrations or a port — and so
 * `server.ts` keeps only the wiring, the way `rest-auth.ts` and `ws-origin.ts` do.
 *
 *   Always:                 B4 every switch is 0|1 · B5 the hub never read the old
 *                           SLAYZONE_HUB_ADDRESS · B8 public address is host[:port] ·
 *                           B15 trusted proxies are IPs/CIDRs ·
 *                           B16 session retention is a whole number of days ·
 *                           B19 STUN servers are host:port authorities ·
 *                           B20 the IdP-role settings parse (even with the mode off)
 *   Started by the app:     B9 listens on loopback
 *   Reachable off-box:      B1 login required · B3 public address set · B10 no raw-SQL
 *   (B13)                   dev endpoint · B14 auth secret in env · B17 it matches any
 *                           secret this hub generated earlier (`assertKeptAuthSecret`)
 *   Login required:         B2 password or SSO on · B7 SSO settings complete: the
 *                           Entra tenant setup OR a generic OpenID issuer, never both
 *                           (and its certificate loads, `assertSsoCredential`) ·
 *                           B20 the IdP-role mode needs SSO on and password off ·
 *                           B11 the auth database loads (`assertAuthLoaded`, once
 *                           the database has been opened) · B18 the computer
 *                           startup completed and left a project-folder host
 *                           (`assertComputersReady`)
 *
 * "Reachable from other machines" (B13) is a listen address that is not loopback OR
 * a public address that is set. The second half is deliberate: a hub on 127.0.0.1
 * behind nginx/Caddy on the same machine IS reachable, and gets every check a hub
 * bound to 0.0.0.0 would.
 *
 * The hub never terminates TLS. A front end in front of a reachable hub does, which
 * is why a public address is required (B3) and why clients dial it with https/wss
 * (`hubUrlFromAddr`, rule A1).
 *
 * `SLAYZONE_MODE` is gone. A leftover value is not read here, so it can neither
 * harden nor weaken anything and there is deliberately no rule that refuses it.
 *
 * @module hub/boot-rules
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  LOOPBACK_HOSTS,
  assertLoopbackBind,
  isBareAuthority,
  parseHubAddress
} from '@slayzone/platform/hub-addr'
import { IdpRoleError, parseConfig, type RoleConfig } from '@normain/idp-role-contract'
import {
  HUB_ADDRESS_ENV,
  HUB_OIDC_ENV,
  HUB_SSO_ENV,
  HUB_SWITCH_ENV,
  HubSwitchValueError,
  LEGACY_HUB_LISTEN_ENV,
  RETIRED_HUB_SSO_CLIENT_SECRET_ENV,
  readHubSessionRetentionDays,
  readHubStunAddresses,
  resolveHubSso,
  resolveHubSwitches,
  type HubSsoSettings,
  type HubSwitches
} from '@slayzone/platform/hub-switches'
import { readTrustedProxies } from '@slayzone/platform/client-address'

/**
 * A boot rule refused to start the hub. `rule` is the plan's number (`B1`…`B17`), or
 * `config-file` for an unusable `hub.config.json`; the bin writes it into the
 * `hub.boot` audit line before it exits (T-03).
 */
export class HubBootRefusal extends Error {
  constructor(
    readonly rule: string,
    message: string
  ) {
    super(message)
    this.name = 'HubBootRefusal'
  }
}

/** The rule a boot error stands for, or null for an error that is not a refusal. */
export function bootRefusalRule(err: unknown): string | null {
  if (err instanceof HubBootRefusal) return err.rule
  // B4 is thrown by the switch parser itself, which the CLI and computer share.
  if (err instanceof HubSwitchValueError) return 'B4'
  return null
}

/** What the boot rules established — everything `server.ts` needs afterwards. */
export interface HubBootSettings {
  switches: HubSwitches
  sso: HubSsoSettings
  /**
   * Entra sign-in is ON: login required AND `ENABLE_SSO=1`, with B7 passed. The one
   * flag every SSO-only rule keys on (the callback route, the role rules, no bootstrap
   * owner). `ENABLE_SSO=1` on a hub without login is inert, like B2/B7 there.
   */
  ssoActive: boolean
  /**
   * The IdP-role mode's config (B20, the shared contract's `parseConfig` over the
   * literal `IDP_*` names). `enabled: false` = off, the default.
   */
  idpRoles: RoleConfig
  /** The host the hub binds. */
  host: string
  /** `SLAYZONE_HUB_PUBLIC_ADDRESS`, trimmed; undefined when unset or blank. */
  publicAddress: string | undefined
  /** B13 — other machines can reach this hub. */
  reachable: boolean
}

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim()
  return t ? t : undefined
}

/**
 * B13: can other machines reach a hub that listens on `host` with this public
 * address? Shared with `standalone-config.ts`, which must know BEFORE it decides
 * whether a missing auth secret may be generated.
 */
export function isHubReachable(host: string, publicAddress: string | undefined): boolean {
  return !LOOPBACK_HOSTS.has(host) || publicAddress !== undefined
}

/**
 * The host an env-configured hub binds: `SLAYZONE_HUB_LISTEN_ADDRESS`'s host, or
 * loopback when it is unset or malformed (a bad address must not silently widen the
 * bind — the same fallback `getServerHost` applies).
 */
export function resolveHubHost(env: NodeJS.ProcessEnv): string {
  return parseHubAddress(env[HUB_ADDRESS_ENV.listen])?.host || '127.0.0.1'
}

/**
 * B13 from env alone, without validating anything. `standalone-config.ts` uses it to
 * decide whether a missing auth secret may be generated; the validating path is
 * {@link assertHubBootRules}.
 */
export function peekHubReachability(env: NodeJS.ProcessEnv): boolean {
  return isHubReachable(resolveHubHost(env), trimmed(env[HUB_ADDRESS_ENV.public]))
}

/**
 * {@link assertHubBootRules} for a STANDALONE boot, deriving the host and the
 * raw-SQL flag from `env`. `standalone-config.ts` runs it right after seeding env from
 * `hub.config.json` and BEFORE it generates a secret onto disk, so a refused hub
 * leaves nothing behind. `startServer` runs the rules again with the host it will
 * actually bind — that is the authoritative check (a programmatic `cfg.host` can differ
 * from env); the early run only exists to put the refusal ahead of the first write.
 */
export function assertHubBootRulesFromEnv(env: NodeJS.ProcessEnv = process.env): HubBootSettings {
  return assertHubBootRules({
    env,
    host: resolveHubHost(env),
    supervised: false,
    // The same predicate as dev-sql.ts's `isDevSqlEnabled`, kept local so this module
    // stays free of the platform barrel and runs under plain node in unit tests.
    devSqlEnabled: env.PLAYWRIGHT === '1'
  })
}

export interface HubBootInput {
  env: NodeJS.ProcessEnv
  /** The resolved bind host (`cfg.host ?? getServerHost()`). */
  host: string
  /** `SLAYZONE_SUPERVISED=1` — started by the desktop app. */
  supervised: boolean
  /** Whether the raw-SQL dev endpoint is switched on (`PLAYWRIGHT=1`). */
  devSqlEnabled: boolean
}

/** Run B4, B5, B8, B15, B9, B1, B3, B10, B14, B16, B19, B2 and B7, in that order. Throws on the first failure. */
export function assertHubBootRules(input: HubBootInput): HubBootSettings {
  const { env, host, supervised } = input

  // B4 — a switch holds exactly 0 or 1. Thrown by the parser, naming the variable.
  const switches = resolveHubSwitches(env)

  // B5 — the old name of the listen address. The hub used to BIND
  // `SLAYZONE_HUB_ADDRESS`; it now only means "the hub to connect to" for a
  // computer / `slay`. Honoring it here would silently put the hub on the wrong
  // address (or, for a dial-side value inherited from a task terminal, a hub that
  // listens somewhere it never meant to), so it refuses instead.
  if (trimmed(env[LEGACY_HUB_LISTEN_ENV]) !== undefined) {
    throw new HubBootRefusal(
      'B5',
      `[slayzone] ${LEGACY_HUB_LISTEN_ENV} was renamed to ${HUB_ADDRESS_ENV.listen} on the ` +
        `hub (where the hub listens, host[:port]). ${LEGACY_HUB_LISTEN_ENV} now only names the ` +
        `hub a computer or \`slay\` connects to — set ${HUB_ADDRESS_ENV.listen} instead, or ` +
        `unset ${LEGACY_HUB_LISTEN_ENV} for the hub (a value inherited from a task terminal ` +
        `is the usual cause).`
    )
  }

  // B8 — the public address is an authority, never a URL. The scheme comes from the
  // host (A1) and the front end owns TLS; a pasted `https://…` would disagree.
  const publicAddress = trimmed(env[HUB_ADDRESS_ENV.public])
  if (publicAddress !== undefined && !isBareAuthority(publicAddress)) {
    throw new HubBootRefusal(
      'B8',
      `[slayzone] ${HUB_ADDRESS_ENV.public} must be host[:port] with no scheme and no path ` +
        `(e.g. hub.example.com or hub.example.com:8443), got '${publicAddress}'. The scheme is ` +
        `derived from the host: a loopback host is http/ws, any other host is https/wss.`
    )
  }

  // B15 — the front ends whose X-Forwarded-For names the client (T-22,
  // client-address.ts) are IPs and CIDRs, every one. Dropping a typo would quietly
  // record the front end as every user; `/0` would let any client name itself.
  const trustedProxies = readTrustedProxies(env)
  if (!trustedProxies.ok) throw new HubBootRefusal('B15', trustedProxies.message)

  // B9 — started by the desktop app ⇒ listens on loopback (login is off there).
  if (supervised) {
    try {
      assertLoopbackBind(host)
    } catch (err) {
      throw new HubBootRefusal('B9', err instanceof Error ? err.message : String(err))
    }
  }

  const reachable = isHubReachable(host, publicAddress)
  const why = LOOPBACK_HOSTS.has(host)
    ? `${HUB_ADDRESS_ENV.public} is set`
    : `it listens on ${host}, not loopback`

  if (reachable) {
    // B1 — an open hub must never be reachable. Keyed on reachability, not on the
    // bind alone, so a loopback hub published through a same-box reverse proxy is
    // covered too.
    if (!switches.requireLogin) {
      throw new HubBootRefusal(
        'B1',
        `[slayzone] ${HUB_SWITCH_ENV.requireLogin}=1 is required: other machines can reach this ` +
          `hub (${why}) and it would serve every client without a sign-in. Set ` +
          `${HUB_SWITCH_ENV.requireLogin}=1, or listen on 127.0.0.1 and unset ` +
          `${HUB_ADDRESS_ENV.public}.`
      )
    }
    // B3 — clients and computers need to be told where the hub is. Only the
    // non-loopback-listen case can reach this with it unset.
    if (publicAddress === undefined) {
      throw new HubBootRefusal(
        'B3',
        `[slayzone] ${HUB_ADDRESS_ENV.public} is required: this hub listens on ${host}, which ` +
          `other machines can reach, but join tokens and links would point at 127.0.0.1. Set ` +
          `${HUB_ADDRESS_ENV.public} to the address clients use (host[:port], no scheme), or ` +
          `listen on 127.0.0.1.`
      )
    }
    // B10 — `/api/dev/sql` is arbitrary SQL against the live database, switched on
    // by an INHERITED env var (`PLAYWRIGHT=1`) that no manifest strips, so it
    // arrives by accident, not by intent. On a reachable hub that is a
    // remote-code-execution primitive nobody asked for. (Loopback-only hubs keep it:
    // e2e legitimately spawns standalone hubs that inherit PLAYWRIGHT=1, and
    // `handleDevSql` independently requires a loopback peer.)
    if (input.devSqlEnabled) {
      throw new HubBootRefusal(
        'B10',
        `[slayzone] PLAYWRIGHT=1 enables the raw-SQL dev endpoint and this hub is reachable ` +
          `from other machines (${why}). Unset PLAYWRIGHT — refusing to boot a hub with ` +
          `arbitrary SQL exposed to the network.`
      )
    }
    // B14 — the signing key of every session and computer credential. A reachable
    // hub takes it from the environment; it never generates one onto its own disk.
    if (trimmed(env[HUB_ADDRESS_ENV.authSecret]) === undefined) {
      throw new HubBootRefusal(
        'B14',
        `[slayzone] ${HUB_ADDRESS_ENV.authSecret} is required in the environment: other machines ` +
          `can reach this hub (${why}), and it must not generate its signing key onto ` +
          `its own disk. If this hub already has data, set it to the existing ` +
          `computerTransportSecret in <ROOT>/hub.state.json — a different value invalidates ` +
          `every session and every enrolled computer's credential. Only for a NEW hub, ` +
          `generate a long random value (e.g. \`openssl rand -hex 32\`).`
      )
    }
  }

  // B16 — the session retention period (T-23, session-retention.ts) is a whole number
  // of days. A typo that fell back to "off" would keep what the operator meant to delete.
  const retention = readHubSessionRetentionDays(env)
  if (!retention.ok) throw new HubBootRefusal('B16', retention.message)

  // B19 — the STUN servers for WebRTC direct links are host:port authorities. A typo
  // that fell back to the default would send every client's address to a server the
  // operator did not choose.
  const stun = readHubStunAddresses(env)
  if (!stun.ok) throw new HubBootRefusal('B19', stun.message)

  const sso = resolveHubSso(env)
  if (switches.requireLogin) {
    // B2 — login with no way to sign in locks everyone out, the operator included.
    if (!switches.enablePassword && !switches.enableSso) {
      throw new HubBootRefusal(
        'B2',
        `[slayzone] ${HUB_SWITCH_ENV.requireLogin}=1 needs a way to sign in, but ` +
          `${HUB_SWITCH_ENV.enablePassword}=0 and ${HUB_SWITCH_ENV.enableSso}=0 — nobody ` +
          `could. Enable ${HUB_SWITCH_ENV.enablePassword} or ${HUB_SWITCH_ENV.enableSso}.`
      )
    }
    // B7 — SSO needs its settings. Checked all-at-once so one boot lists every gap.
    // The public address is one of them: Entra redirects back to
    // https://<public address>/api/auth/callback/microsoft, which must be registered on
    // the app and must not move. Whether the certificate actually loads is the second
    // half of B7, checked in server.ts (it reads files; this module does no I/O).
    if (switches.enableSso && sso.issuer !== undefined) assertGenericOidc(env, sso, publicAddress)
    else if (switches.enableSso) {
      const missing: string[] = []
      if (!sso.tenantId) missing.push(HUB_SSO_ENV.tenantId)
      if (!sso.clientId) missing.push(HUB_SSO_ENV.clientId)
      if (!sso.certPath) missing.push(HUB_SSO_ENV.certPath)
      if (!sso.keyPath) missing.push(HUB_SSO_ENV.keyPath)
      if (publicAddress === undefined) missing.push(HUB_ADDRESS_ENV.public)
      if (missing.length > 0) {
        throw new HubBootRefusal(
          'B7',
          `[slayzone] ${HUB_SWITCH_ENV.enableSso}=1 needs its SSO settings; missing: ` +
            `${missing.join(', ')}.`
        )
      }
      // Single tenant: every ID token's `tid` and issuer are compared against this
      // value, and Entra writes them as GUIDs — a domain name or `common` would
      // refuse every sign-in, so it refuses the boot instead.
      const notGuid = [
        [HUB_SSO_ENV.tenantId, sso.tenantId],
        [HUB_SSO_ENV.clientId, sso.clientId]
      ].filter(([, v]) => !GUID.test(v ?? ''))
      if (notGuid.length > 0) {
        throw new HubBootRefusal(
          'B7',
          `[slayzone] ${notGuid.map(([k, v]) => `${k} must be a GUID, got '${v}'`).join('; ')}. ` +
            `Use the Directory (tenant) ID and Application (client) ID from the app ` +
            `registration's Overview page.`
        )
      }
      // The hub authenticates to Entra with a certificate only. A leftover secret
      // would read as "configured" while nothing uses it.
      if (trimmed(env[RETIRED_HUB_SSO_CLIENT_SECRET_ENV]) !== undefined) {
        throw new HubBootRefusal(
          'B7',
          `[slayzone] ${RETIRED_HUB_SSO_CLIENT_SECRET_ENV} is not used: the hub signs in to ` +
            `Entra with a certificate (${HUB_SSO_ENV.certPath} + ${HUB_SSO_ENV.keyPath}). ` +
            `Unset it, and delete the client secret from the app registration.`
        )
      }
    }
  }

  const ssoActive = switches.requireLogin && switches.enableSso

  // B20 — the IdP-role mode (the shared contract, @normain/idp-role-contract). Its
  // settings are parsed on EVERY hub, mode on or off: a malformed value, an unknown
  // target role, an empty mapping or a retired name (`SLAYZONE_HUB_SSO_*ROLE*`,
  // Kahuna's and Cloudable's old names) refuses boot rather than being ignored. With the
  // mode on, roles come only from SSO: SSO must be on and password sign-in off.
  let idpRoles: RoleConfig
  try {
    idpRoles = parseConfig(env, IDP_ROLE_TARGETS)
  } catch (err) {
    throw new HubBootRefusal(
      'B20',
      `[slayzone] ${err instanceof IdpRoleError ? err.message : 'IdP role settings are invalid'} ` +
        `(IDP_ROLES_ENABLED, IDP_ROLE_CLAIM, IDP_ROLE_MAPPING, IDP_RECHECK_INTERVAL_SECONDS; ` +
        `see docs/hub-sso-roles.md).`
    )
  }
  if (idpRoles.enabled && !ssoActive) {
    throw new HubBootRefusal(
      'B20',
      `[slayzone] IDP_ROLES_ENABLED=true takes every role from the identity provider at ` +
        `sign-in, but SSO sign-in is not on (needs ${HUB_SWITCH_ENV.requireLogin}=1 and ` +
        `${HUB_SWITCH_ENV.enableSso}=1).`
    )
  }
  if (idpRoles.enabled && switches.enablePassword) {
    throw new HubBootRefusal(
      'B20',
      `[slayzone] IDP_ROLES_ENABLED=true requires ${HUB_SWITCH_ENV.enablePassword}=0: with roles ` +
        `managed by the identity provider, sign-in is through SSO only (recovery: ` +
        `\`slayzone-hub break-glass\` on the hub machine).`
    )
  }

  return { switches, sso, ssoActive, idpRoles, host, publicAddress, reachable }
}

/** The hub roles the IdP-role mapping may target. */
export const IDP_ROLE_TARGETS: readonly string[] = ['admin', 'user']

/** An https issuer URL (no query, no fragment). */
const isHttpsIssuer = (v: string): boolean => {
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.search && !u.hash && !u.username && !u.password
  } catch {
    return false
  }
}

/**
 * B7 for a generic OpenID issuer (`SLAYZONE_HUB_OIDC_ISSUER` set). The Entra tenant
 * settings must not be set with it (two setups is contradictory); a client id; exactly
 * one client credential — the certificate pair or a client secret; `openid` in the
 * scopes; the public address (the issuer redirects to
 * https://<public address>/api/auth/callback/oidc, or /callback/microsoft for an Entra
 * issuer). An Entra issuer authenticates with the certificate only, as the tenant setup.
 */
function assertGenericOidc(
  env: NodeJS.ProcessEnv,
  sso: HubSsoSettings,
  publicAddress: string | undefined
): void {
  const contradictory = [HUB_SSO_ENV.tenantId, HUB_SSO_ENV.clientId].filter(
    (k) => trimmed(env[k]) !== undefined
  )
  if (contradictory.length > 0) {
    throw new HubBootRefusal(
      'B7',
      `[slayzone] ${HUB_OIDC_ENV.issuer} is set together with ${contradictory.join(' and ')}: ` +
        `use the Entra tenant settings OR the generic OIDC settings, not both. To move to ` +
        `the generic settings, set ${HUB_OIDC_ENV.issuer}=https://login.microsoftonline.com/` +
        `<tenant id>/v2.0 and ${HUB_OIDC_ENV.clientId}, and unset ${contradictory.join(', ')}.`
    )
  }
  const missing: string[] = []
  if (!sso.oidcClientId) missing.push(HUB_OIDC_ENV.clientId)
  const hasCert = sso.certPath !== undefined || sso.keyPath !== undefined
  if (!hasCert && !sso.clientSecret) {
    missing.push(`${HUB_SSO_ENV.certPath} + ${HUB_SSO_ENV.keyPath} or ${HUB_OIDC_ENV.clientSecret}`)
  }
  if (hasCert && (!sso.certPath || !sso.keyPath)) {
    missing.push(sso.certPath ? HUB_SSO_ENV.keyPath : HUB_SSO_ENV.certPath)
  }
  if (publicAddress === undefined) missing.push(HUB_ADDRESS_ENV.public)
  if (missing.length > 0) {
    throw new HubBootRefusal(
      'B7',
      `[slayzone] ${HUB_OIDC_ENV.issuer} needs its settings; missing: ${missing.join(', ')}.`
    )
  }
  if (hasCert && sso.clientSecret) {
    throw new HubBootRefusal(
      'B7',
      `[slayzone] set ONE client credential: the certificate (${HUB_SSO_ENV.certPath} + ` +
        `${HUB_SSO_ENV.keyPath}) or ${HUB_OIDC_ENV.clientSecret}, not both.`
    )
  }
  if (!isHttpsIssuer(sso.issuer ?? '')) {
    throw new HubBootRefusal(
      'B7',
      `[slayzone] ${HUB_OIDC_ENV.issuer} must be the issuer's https URL exactly as its tokens' ` +
        `"iss", got '${sso.issuer}'.`
    )
  }
  if (ENTRA_ISSUER.test((sso.issuer ?? '').replace(/\/+$/, '')) && !hasCert) {
    throw new HubBootRefusal(
      'B7',
      `[slayzone] an Entra issuer authenticates with a certificate (${HUB_SSO_ENV.certPath} + ` +
        `${HUB_SSO_ENV.keyPath}), not ${HUB_OIDC_ENV.clientSecret}.`
    )
  }
  if (sso.scopes && !sso.scopes.includes('openid')) {
    throw new HubBootRefusal('B7', `[slayzone] ${HUB_OIDC_ENV.scopes} must include openid.`)
  }
  if (trimmed(env[RETIRED_HUB_SSO_CLIENT_SECRET_ENV]) !== undefined) {
    throw new HubBootRefusal(
      'B7',
      `[slayzone] ${RETIRED_HUB_SSO_CLIENT_SECRET_ENV} is not read; a generic issuer's secret ` +
        `is ${HUB_OIDC_ENV.clientSecret}.`
    )
  }
}

const ENTRA_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v2\.0$/i

/**
 * B17 — a hub other machines can reach takes its auth secret from env (B14), but its
 * ROOT may still hold the one it generated while only this machine reached it:
 * `computerTransportSecret` in `hub.state.json` (or the legacy `config.json`). Such a
 * hub reads that file for this check only and never writes it (T-11). A DIFFERENT value
 * in env would silently sign every session out and leave the stored Entra tokens and
 * the JWT signing key (both encrypted with it) unreadable, so it refuses instead. The
 * same value boots; the caller tells the operator the file can go.
 *
 * Pure: the caller reads the file (standalone-config.ts). Neither value is ever put in
 * the message. Returns `'kept'` when the file holds the env value, `'none'` when there
 * is nothing to compare (not reachable, or no kept secret).
 */
export function assertKeptAuthSecret(input: {
  reachable: boolean
  envSecret: string | undefined
  kept: string | undefined
  keptPath: string
}): 'none' | 'kept' {
  const { reachable, envSecret, kept } = input
  if (!reachable || !kept || !envSecret) return 'none'
  const digest = (v: string): Buffer => createHash('sha256').update(v, 'utf8').digest()
  if (timingSafeEqual(digest(envSecret), digest(kept))) return 'kept'
  throw new HubBootRefusal(
    'B17',
    `[slayzone] ${HUB_ADDRESS_ENV.authSecret} differs from the computerTransportSecret this ` +
      `hub generated in ${input.keptPath}. Booting with it would sign every session out and ` +
      `leave the stored Entra tokens and the hub's JWT signing key unreadable. Set ` +
      `${HUB_ADDRESS_ENV.authSecret} to the value in that file — or, to replace the secret ` +
      `on purpose (everyone signs in again), delete the file. The hub only compares the ` +
      `two; it never writes the file.`
  )
}

/** A GUID as Entra writes tenant and client ids (case-insensitive). */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What SSO sign-in runs with, once B7 has passed in full: the Entra tenant setup
 * (`tenantId` set) or a generic issuer (`issuer` set; a certificate `credential` or a
 * `clientSecret`). `idpRoles`: the IdP-role mode (B20), null when off.
 */
export interface HubSsoBootConfig<C> {
  /** Entra tenant setup. Lowercased: Entra writes `tid` and `aud` lowercase. */
  tenantId?: string
  /** Generic OpenID issuer. */
  issuer?: string
  clientId: string
  requireMfa: boolean
  credential?: C
  clientSecret?: string
  scopes?: string[]
  idpRoles: RoleConfig | null
}

/**
 * B7, second half: the certificate and its private key load. Null when Entra sign-in
 * is off. `load` does the reading (server.ts passes hub-auth's
 * `loadEntraClientCredential`), so this module stays free of I/O and of hub-auth.
 * Runs in `startServer` right after {@link assertHubBootRules}, before the hub opens
 * its database — an unreadable or mismatched key refuses the boot, it does not
 * surface as every sign-in failing. The message names paths, never file contents.
 */
export function assertSsoCredential<C>(
  boot: HubBootSettings,
  load: (paths: { certPath: string; keyPath: string }) => C
): HubSsoBootConfig<C> | null {
  if (!boot.ssoActive) return null
  const idpRoles = boot.idpRoles.enabled ? boot.idpRoles : null
  const { tenantId, clientId, certPath, keyPath, requireMfa, issuer } = boot.sso
  if (issuer !== undefined) {
    // B7 (generic) guarantees a client id and one credential.
    const oidcClientId = boot.sso.oidcClientId ?? ''
    const base = {
      issuer: issuer.replace(/\/+$/, ''),
      clientId: oidcClientId,
      requireMfa,
      idpRoles,
      ...(boot.sso.scopes ? { scopes: boot.sso.scopes } : {})
    }
    if (boot.sso.clientSecret) return { ...base, clientSecret: boot.sso.clientSecret }
    return { ...base, credential: loadCredential(load, certPath ?? '', keyPath ?? '') }
  }
  // B7 guarantees all four once SSO is active.
  if (!tenantId || !clientId || !certPath || !keyPath) {
    throw new HubBootRefusal('B7', '[slayzone] SSO settings incomplete')
  }
  let credential: C
  try {
    credential = load({ certPath, keyPath })
  } catch (err) {
    throw new HubBootRefusal(
      'B7',
      `[slayzone] ${HUB_SSO_ENV.certPath} / ${HUB_SSO_ENV.keyPath}: ` +
        `${err instanceof Error ? err.message : String(err)}. Point them at the PEM ` +
        `certificate uploaded to the Entra app registration and its unencrypted RSA key.`
    )
  }
  return {
    tenantId: tenantId.toLowerCase(),
    clientId: clientId.toLowerCase(),
    requireMfa,
    credential,
    idpRoles
  }
}

function loadCredential<C>(
  load: (paths: { certPath: string; keyPath: string }) => C,
  certPath: string,
  keyPath: string
): C {
  try {
    return load({ certPath, keyPath })
  } catch (err) {
    throw new HubBootRefusal(
      'B7',
      `[slayzone] ${HUB_SSO_ENV.certPath} / ${HUB_SSO_ENV.keyPath}: ` +
        `${err instanceof Error ? err.message : String(err)}. Point them at the PEM ` +
        `certificate registered with the issuer and its unencrypted RSA key.`
    )
  }
}

/**
 * B11 — when login is required the auth database must have loaded. Fails CLOSED:
 * a hub whose auth failed to initialize must not fall back to serving every client
 * unauthenticated. (Computers already fail closed — a broken auth DB makes enroll
 * unavailable rather than unauthenticated.)
 */
export function assertAuthLoaded(requireLogin: boolean, hubAuth: unknown | null): void {
  if (requireLogin && !hubAuth) {
    throw new HubBootRefusal(
      'B11',
      `[slayzone] ${HUB_SWITCH_ENV.requireLogin}=1 but hub auth failed to initialize — refusing ` +
        `to boot a hub that cannot check who is signing in. Check the auth database in the ` +
        `hub's data directory and the hub log.`
    )
  }
}

/**
 * B18 — when login is required the computer startup must have completed and left a
 * project-folder host. Fails CLOSED: without the host, a project's folder fell back to
 * the legacy `projects.path` column — a record of the HUB's disk — written after only
 * the computer-side owner check, so a user could claim `/` and read every hub file
 * (round-10 R10-1). The desktop (no login) still boots degraded, as before.
 */
export function assertComputersReady(
  requireLogin: boolean,
  state: { folderHost: boolean; initError: Error | null }
): void {
  if (!requireLogin) return
  if (state.initError) {
    throw new HubBootRefusal(
      'B18',
      `[slayzone] ${HUB_SWITCH_ENV.requireLogin}=1 but the computer startup failed ` +
        `(${state.initError.message}) — refusing to boot a hub that cannot record where ` +
        `project folders live. Check the hub log and its data directory.`
    )
  }
  if (!state.folderHost) {
    throw new HubBootRefusal(
      'B18',
      `[slayzone] ${HUB_SWITCH_ENV.requireLogin}=1 but no project folder host was set up — ` +
        `refusing to boot: project folders would be recorded on the hub's own disk.`
    )
  }
}
