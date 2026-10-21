import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { bearer, jwt, organization } from 'better-auth/plugins'
import { refuseDisabledSessions } from './account'
import { auditAuthResponse, auditDatabaseHooks } from './audit'
import { ensureFirstAdmin } from './users'

export interface HubAuthConfig {
  /**
   * Path to the hub-auth sqlite file (e.g. `<dataDir>/hub-auth.sqlite`).
   * This is hub-auth's OWN database — never the app's SlayzoneDb.
   */
  dbPath: string
  /** Public base URL the auth endpoints are served under (e.g. `http://127.0.0.1:4141`). */
  baseURL: string
  /** Secret used for session-cookie signing and hashing. */
  secret: string
}

/** Prefix minted computer API keys start with (SlayZone computer). */
export const COMPUTER_KEY_PREFIX = 'szr_'

/**
 * Options are built inline inside `betterAuth()` so the instance type keeps
 * the plugin-inferred `auth.api` endpoints (bearer/jwt/organization/apiKey).
 */
function buildAuth(config: HubAuthConfig, database: DatabaseSync) {
  // Bound below, once the instance exists — the session guard only runs after
  // betterAuth() has returned. Until then it fails closed.
  let findUser = (_userId: string): Promise<Record<string, unknown> | null> =>
    Promise.reject(new Error('[hub-auth] user lookup used before the instance was built'))
  const auth = betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
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
    emailAndPassword: { enabled: true, disableSignUp: true },
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
    // Hard guarantee: never phone home (better-auth telemetry is opt-in, we
    // still pin it off).
    telemetry: { enabled: false },
    // Security audit lines on stdout (T-03): sign-in, sign-out, sessions, password
    // change. See ./audit.ts.
    hooks: { after: auditAuthResponse },
    databaseHooks: {
      session: {
        create: {
          // A disabled account gets no session, whichever route asked for one.
          before: refuseDisabledSessions((userId) => findUser(userId)),
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
      })
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
 * migration registry. Then {@link ensureFirstAdmin}: a hub upgraded from before
 * the `role` column makes its oldest account admin.
 */
export async function createHubAuth(config: HubAuthConfig): Promise<HubAuth> {
  mkdirSync(dirname(config.dbPath), { recursive: true })
  const database = new DatabaseSync(config.dbPath)
  database.exec('PRAGMA journal_mode = WAL;')
  const auth = buildAuth(config, database)
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  await ensureFirstAdmin(auth)
  return auth
}
