import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { bearer, jwt, organization } from 'better-auth/plugins'

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

/** Prefix minted runner API keys start with (SlayZone runner). */
export const RUNNER_KEY_PREFIX = 'szr_'

/**
 * Options are built inline inside `betterAuth()` so the instance type keeps
 * the plugin-inferred `auth.api` endpoints (bearer/jwt/organization/apiKey).
 */
function buildAuth(config: HubAuthConfig, database: DatabaseSync) {
  return betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    // node:sqlite handle — better-auth's kysely adapter wraps it in its own
    // NodeSqliteDialect. Chosen over better-sqlite3: this repo rebuilds
    // better-sqlite3 against Electron's ABI, which breaks plain-node
    // consumers (vitest, CI); node:sqlite is ABI-proof in both runtimes.
    database,
    emailAndPassword: { enabled: true },
    // Hard guarantee: never phone home (better-auth telemetry is opt-in, we
    // still pin it off).
    telemetry: { enabled: false },
    plugins: [
      bearer(),
      jwt(),
      organization(),
      apiKey({
        // Runner identity travels in key metadata ({ runnerId }).
        enableMetadata: true,
        defaultPrefix: RUNNER_KEY_PREFIX
      })
    ]
  })
}

export type HubAuth = ReturnType<typeof buildAuth>

/**
 * Create the hub-auth better-auth instance backed by its own sqlite file and
 * bring that file's schema up to date via better-auth's own migration
 * mechanism (`getMigrations` from `better-auth/db/migration`) — NOT the app's
 * migration registry.
 */
export async function createHubAuth(config: HubAuthConfig): Promise<HubAuth> {
  mkdirSync(dirname(config.dbPath), { recursive: true })
  const database = new DatabaseSync(config.dbPath)
  database.exec('PRAGMA journal_mode = WAL;')
  const auth = buildAuth(config, database)
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  return auth
}
