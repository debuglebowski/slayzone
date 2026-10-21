import { join } from 'node:path'
import { adoptRenamedDatabase } from '@slayzone/platform'

/**
 * The hub's accounts, sessions and computer API keys (better-auth's own database).
 *
 * Named `slayzone.auth.sqlite`, a sibling of `slayzone.data.sqlite` and
 * `slayzone.diagnostics.sqlite`. It was `hub-auth.sqlite` in the betas; beta hubs and
 * standalone hubs still have that name on disk.
 */
export const AUTH_DB_NAME = 'slayzone.auth.sqlite'
export const LEGACY_AUTH_DB_NAME = 'hub-auth.sqlite'

/**
 * The path to open, after moving a beta's file (and its WAL) to the new name.
 *
 * Must run BEFORE `createHubAuth`: it creates the file if absent, so opening the new
 * name first would leave a fresh empty auth database beside the real one — every
 * enrolled computer's key rejected and every owner login gone. Credentials are never
 * recreated by anything else.
 */
export function resolveAuthDbPath(dataRoot: string): string {
  adoptRenamedDatabase(dataRoot, LEGACY_AUTH_DB_NAME, AUTH_DB_NAME)
  return join(dataRoot, AUTH_DB_NAME)
}
