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
 *                           SLAYZONE_HUB_ADDRESS · B8 public address is host[:port]
 *   Started by the app:     B9 listens on loopback
 *   Reachable off-box:      B1 login required · B3 public address set · B10 no raw-SQL
 *   (B13)                   dev endpoint · B14 auth secret in env
 *   Login required:         B2 password or SSO on · B7 SSO settings complete (and
 *                           its certificate loads, `assertSsoCredential`) ·
 *                           B11 the auth database loads (`assertAuthLoaded`, once
 *                           the database has been opened)
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
import {
  LOOPBACK_HOSTS,
  assertLoopbackBind,
  isBareAuthority,
  parseHubAddress
} from '@slayzone/platform/hub-addr'
import {
  HUB_ADDRESS_ENV,
  HUB_SSO_ENV,
  HUB_SWITCH_ENV,
  HubSwitchValueError,
  LEGACY_HUB_LISTEN_ENV,
  RETIRED_HUB_SSO_CLIENT_SECRET_ENV,
  resolveHubSso,
  resolveHubSwitches,
  type HubSsoSettings,
  type HubSwitches
} from '@slayzone/platform/hub-switches'

/**
 * A boot rule refused to start the hub. `rule` is the plan's number (`B1`…`B14`), or
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

/** Run B4, B5, B8, B9, B1, B3, B10, B14, B2 and B7, in that order. Throws on the first failure. */
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
    if (switches.enableSso) {
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
  return { switches, sso, ssoActive, host, publicAddress, reachable }
}

/** A GUID as Entra writes tenant and client ids (case-insensitive). */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What Entra sign-in runs with, once B7 has passed in full. */
export interface HubSsoBootConfig<C> {
  /** Lowercased: Entra writes `tid` and `aud` lowercase. */
  tenantId: string
  clientId: string
  requireMfa: boolean
  credential: C
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
  const { tenantId, clientId, certPath, keyPath, requireMfa } = boot.sso
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
    credential
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
