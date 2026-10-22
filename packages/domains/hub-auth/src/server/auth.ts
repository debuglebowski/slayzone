import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { bearer, jwt, organization } from 'better-auth/plugins'
import { CLIENT_ADDRESS_HEADER } from '@slayzone/platform/client-address'
import { refuseDisabledSessions } from './account'
import { auditAuthResponse, auditDatabaseHooks } from './audit'
import {
  type EntraSsoConfig,
  entraSso,
  entraUserCreateAfter,
  entraUserCreateBefore,
  syncEntraRole
} from './entra'
import { PASSWORD_AUTH_ENDPOINTS } from './password'
import { demoteNonEntraAdmins, ensureFirstAdmin } from './users'

export interface HubAuthConfig {
  /**
   * Path to the hub-auth sqlite file (e.g. `<dataDir>/slayzone.auth.sqlite`).
   * This is hub-auth's OWN database — never the app's SlayzoneDb.
   */
  dbPath: string
  /**
   * Public base URL the auth endpoints are served under (e.g. `https://hub.example.com`).
   * Entra's redirect URI is built from it (`<baseURL>/api/auth/callback/microsoft`), and
   * its origin is trusted for browser requests.
   */
  baseURL: string
  /** Secret used for session-cookie signing and hashing. */
  secret: string
  /** Further browser origins better-auth trusts (callback URLs, CSRF origin check). */
  trustedOrigins?: string[]
  /**
   * Entra ID sign-in (T-09, ./entra.ts). Absent = no SSO: the desktop app's hub and
   * every hub without `SLAYZONE_HUB_ENABLE_SSO=1` + login required.
   */
  sso?: EntraSsoConfig
  /**
   * `SLAYZONE_HUB_ENABLE_PASSWORD` (T-10, ./password.ts). Default on: the desktop app's
   * hub and every hub that does not set it to 0. Off: no password sign-in, sign-up,
   * change or reset, and no account with a generated password; existing password
   * credentials are kept but cannot be used.
   */
  enablePassword?: boolean
}

/** Prefix minted computer API keys start with (SlayZone computer). */
export const COMPUTER_KEY_PREFIX = 'szr_'

/**
 * Full (better-auth) session lifetime, every hub (O-8, T-12): 7 days, renewed to 7 days
 * from now at most once a day while it is used — so it ends 7 days after its last use.
 * Both are better-auth's defaults, written down so an upgrade cannot move them. Not
 * absolute, unlike a web session (web-sessions.ts in the hub): these are the desktop
 * app's and the CLI's sessions, and on a hub with Entra sign-in the hourly re-check
 * (./entra-recheck.ts) ends a leaver's within the hour anyway. `cookieCache` stays off:
 * with it on, `getSession` answers from a signed cookie for its max age without reading
 * the session or the user, so a revoked session or a disabled account would still pass.
 */
export const SESSION_LIFETIME = {
  expiresIn: 7 * 24 * 60 * 60,
  updateAge: 24 * 60 * 60,
  cookieCache: { enabled: false }
} as const

/**
 * Options are built inline inside `betterAuth()` so the instance type keeps
 * the plugin-inferred `auth.api` endpoints (bearer/jwt/organization/apiKey).
 */
function buildAuth(config: HubAuthConfig, database: DatabaseSync) {
  // Bound below, once the instance exists — the session guard only runs after
  // betterAuth() has returned. Until then it fails closed.
  let findUser = (_userId: string): Promise<Record<string, unknown> | null> =>
    Promise.reject(new Error('[hub-auth] user lookup used before the instance was built'))
  const refuseDisabled = refuseDisabledSessions((userId) => findUser(userId))
  const passwordOn = config.enablePassword !== false
  const auth = betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    ...(config.trustedOrigins?.length ? { trustedOrigins: config.trustedOrigins } : {}),
    // node:sqlite handle — better-auth's kysely adapter wraps it in its own
    // NodeSqliteDialect. Chosen over better-sqlite3: this repo rebuilds
    // better-sqlite3 against Electron's ABI, which breaks plain-node
    // consumers (vitest, CI); node:sqlite is ABI-proof in both runtimes.
    database,
    // Public signup is CLOSED. `/api/auth/sign-up/email` is necessarily exempt
    // from the hub's bearer gate (see rest-auth.ts — a client holding no token has
    // to reach it to obtain one), so leaving it open meant anyone who could reach
    // an internet-facing hub could self-register into full access: pty spawn,
    // browser eval, file ops. better-auth enforces this flag inside the route
    // itself (`if (!enabled || disableSignUp) throw BAD_REQUEST`), so the route now
    // refuses at the source and the gate exemption is harmless. Sign-in and
    // get-session are unaffected.
    //
    // Accounts therefore come from `createHubUser` (./users.ts), reached over the
    // loopback-only `/api/hub/users` route that backs `slay hub users add` — a
    // shell on the hub box is the credential, exactly as for
    // `POST /api/computers/join-token`.
    //
    // With the password switch off (T-10) email + password is off altogether and its
    // endpoints are not served (404) — see ./password.ts.
    emailAndPassword: { enabled: passwordOn, disableSignUp: true },
    ...(passwordOn ? {} : { disabledPaths: Object.keys(PASSWORD_AUTH_ENDPOINTS) }),
    // Account model (T-08), see ./account.ts. `input: false` on both: neither
    // sign-up nor `/update-user` may set them (better-auth answers
    // FIELD_NOT_ALLOWED); only ./users.ts writes them. `getMigrations` adds the
    // columns to an existing `user` table without a default, so a row from before
    // reads NULL — `readRole` reads that as 'user'.
    user: {
      additionalFields: {
        role: { type: 'string', required: false, defaultValue: 'user', input: false },
        disabledAt: { type: 'date', required: false, input: false }
      }
    },
    // 7 days (O-8), see SESSION_LIFETIME above.
    session: { ...SESSION_LIFETIME },
    // OAuth accounts (only Entra's, ./entra.ts; inert on a hub without SSO). An Entra
    // identity is the `account` row keyed on `<oid>.<tid>` and is NEVER linked to an
    // existing user by email: Entra's `email` claim is mutable and not proof of
    // ownership, so implicit linking would let whoever gets an address hijack the
    // account that holds it. A sign-in whose email already belongs to another account
    // is refused (`account_not_linked`). The refresh token kept on the row (O-8) is
    // encrypted with the auth secret.
    account: {
      accountLinking: { enabled: false },
      encryptOAuthTokens: true
    },
    // Hard guarantee: never phone home (better-auth telemetry is opt-in, we
    // still pin it off).
    telemetry: { enabled: false },
    // Client IP (T-22): the session row's `ipAddress` and the rate-limit key. By default
    // better-auth reads `X-Forwarded-For`, which any client can send — a direct caller
    // could pick the IP it is recorded and rate-limited under — and it cannot see the
    // TCP peer to check who sent it. So it reads ONLY the header the hub overwrites on
    // every request with the address it resolved from the peer and its trusted front
    // ends (`adoptClientAddress`); an in-process `auth.api.*` call carries none, so
    // records none (better-auth's dev/test fallback is 127.0.0.1). `trustedProxyHeaders:
    // false` pins that X-Forwarded-Host/-Proto never move the base URL (env rule 5).
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
      trustedProxyHeaders: false
    },
    // Security audit lines on stdout (T-03): sign-in, sign-out, sessions, password
    // change. See ./audit.ts.
    hooks: { after: auditAuthResponse },
    databaseHooks: {
      // The Entra hooks act only inside an Entra callback whose ID token passed the
      // checks (request-scoped, see entra.ts); everywhere else they return untouched.
      user: { create: { before: entraUserCreateBefore, after: entraUserCreateAfter } },
      session: {
        create: {
          // A disabled account gets no session, whichever route asked for one. Then an
          // Entra sign-in sets the role its token carries — in that order, so a refused
          // sign-in changes nothing.
          before: async (session, ctx) => {
            await refuseDisabled(session, ctx)
            await syncEntraRole(session, ctx)
          },
          after: auditDatabaseHooks.session.create.after
        },
        delete: auditDatabaseHooks.session.delete
      }
    },
    plugins: [
      bearer(),
      jwt(),
      organization(),
      apiKey({
        // Computer identity travels in key metadata ({ computerId }).
        //
        // Attacker-controlled: `POST /api/auth/api-key/create` is session-
        // authenticated and gate-exempt (it sits under `/api/auth/`), so any
        // account holder can set this freely. `verifyComputerApiKey` therefore
        // treats metadata as a HINT and authenticates on `referenceId` — see its
        // docstring. Do not add an authorization decision that reads metadata.
        enableMetadata: true,
        // An api-key must never BE a session. Default is already false, but
        // written explicitly for the same reason `rateLimit` is: if this ever
        // flips, an `x-api-key` header becomes a full user session and every
        // computer credential silently becomes a login.
        enableSessionForAPIKeys: false,
        defaultPrefix: COMPUTER_KEY_PREFIX,
        // Computer keys are MACHINE credentials verified once per reconnect, so the
        // plugin's default verify limit (10 requests / 24h, ON unless set) bricks
        // them: the 11th reconnect in a day is denied, `verifyComputerApiKey` returns
        // null, the gateway answers `hello` with -32002, and the computer's re-enroll
        // fallback burns its single-use join token and exits fatally. Hub restarts,
        // laptop sleep and network flaps clear 10 reconnects/day easily.
        //
        // Turning it off costs no security: `validateApiKey` LOOKS THE KEY UP FIRST
        // and evaluates the limit only after, so an unknown key never reaches it —
        // it throttles nobody but the legitimate holder. Revocation
        // (`revokeComputerApiKey`) and the `computers.revoked_at` check in
        // `verifyApiKey` are the real controls. Written explicitly rather than left
        // default because the default is a footgun for this key class.
        rateLimit: { enabled: false }
      }),
      ...(config.sso ? [entraSso(config.sso)] : [])
    ]
  })
  findUser = async (userId) =>
    (await (await auth.$context).internalAdapter.findUserById(userId)) as Record<
      string,
      unknown
    > | null
  return auth
}

export type HubAuth = ReturnType<typeof buildAuth>

/**
 * Create the hub-auth better-auth instance backed by its own sqlite file and
 * bring that file's schema up to date via better-auth's own migration
 * mechanism (`getMigrations` from `better-auth/db/migration`) — NOT the app's
 * migration registry. Then the admin boot step: {@link ensureFirstAdmin} (a hub
 * upgraded from before the `role` column makes its oldest account admin), or on a hub
 * with Entra sign-in {@link demoteNonEntraAdmins} (admin comes only from the Entra app
 * role there, O-4).
 */
export async function createHubAuth(config: HubAuthConfig): Promise<HubAuth> {
  mkdirSync(dirname(config.dbPath), { recursive: true })
  const database = new DatabaseSync(config.dbPath)
  database.exec('PRAGMA journal_mode = WAL;')
  const auth = buildAuth(config, database)
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  if (config.sso) await demoteNonEntraAdmins(auth)
  else await ensureFirstAdmin(auth)
  return auth
}
