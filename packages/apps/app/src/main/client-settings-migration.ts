import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  CLIENT_SETTINGS_KEYS,
  readClientSettings,
  updateClientSettings,
  type ClientSettings
} from '@slayzone/platform/client-settings'

/**
 * One-time move of the client-scoped settings out of the shared database.
 *
 * THIS IS THE LAST TIME THE MAIN PROCESS EVER OPENS THE SHARED DATABASE. That is
 * the whole point of the exercise, and it is why the `better-sqlite3` import here
 * is a named carve-out in `scripts/check-server-electron-free.sh` rather than a
 * violation — it is a read-only, single-statement, one-shot read that deletes
 * itself via a sentinel.
 *
 * SAFETY, in the shape the storage-migration incident taught (see the header of
 * `storage-migration.ts`, where a copy-then-DELETE run by a dev build destroyed a
 * live production database):
 *
 *  - COPY ONLY. No `DELETE FROM settings`, ever. The rows stay exactly as they
 *    were, which is also the downgrade path: an older build still finds them.
 *  - NEVER CLOBBER. A key is copied only when its destination is ABSENT, so a
 *    crash between the write and the sentinel cannot let the retry stomp a value
 *    the user set in between.
 *  - READ BACK AND VERIFY before writing the sentinel — never in a `catch`. A
 *    silent partial write that then marks itself done is the one outcome that
 *    loses settings permanently, because the sentinel blocks the retry.
 *  - `readonly: true` guarantees this open cannot create the file, take a write
 *    lock, or run a migration by accident.
 *
 * REMOTE MODE. The source is the LOCAL database file, never the remote hub. A
 * remote-mode user's rows live on a server, and a client upgrade must never mutate
 * a server as a side effect. What main was *actually* reading in remote mode was
 * the local file — mostly migration-seeded defaults — so migrating exactly that
 * preserves current behavior. Their rows on the hub stay, and keep being ignored,
 * exactly as today.
 */

/** Per-channel, and channel-scoped for free by living in the channel-scoped root. */
function sentinelPath(clientRoot: string): string {
  return join(clientRoot, '.client-settings-migrated')
}

const asBool = (v: string | undefined): boolean | undefined =>
  v === undefined ? undefined : v === '1' || v === 'true'

/** Shape the flat `settings` rows into the store's nested form. */
function toClientSettings(rows: Map<string, string>): Partial<ClientSettings> {
  const out: Partial<ClientSettings> = {}
  const theme = rows.get('theme')
  if (theme === 'light' || theme === 'dark' || theme === 'system') out.theme = theme

  const shortcuts = rows.get('custom_shortcuts')
  if (shortcuts) {
    try {
      out.customShortcuts = JSON.parse(shortcuts)
    } catch {
      /* a malformed blob migrates as unset, not as garbage */
    }
  }

  const testsPanel = asBool(rows.get('labs_tests_panel'))
  const loopMode = asBool(rows.get('labs_loop_mode'))
  if (testsPanel !== undefined || loopMode !== undefined) out.labs = { testsPanel, loopMode }

  const panelConfig = rows.get('floatingGlobalAgentPanelConfig')
  const panelSize = rows.get('floatingGlobalAgentPanelExpandedSize')
  if (panelConfig || panelSize) {
    const panel: NonNullable<ClientSettings['floatingAgentPanel']> = {}
    if (panelConfig) {
      try {
        panel.config = JSON.parse(panelConfig)
      } catch {
        /* ignore */
      }
    }
    if (panelSize) {
      try {
        const parsed = JSON.parse(panelSize)
        if (typeof parsed?.width === 'number' && typeof parsed?.height === 'number') {
          panel.expandedSize = { width: parsed.width, height: parsed.height }
        }
      } catch {
        /* ignore */
      }
    }
    out.floatingAgentPanel = panel
  }

  const diagEnabled = asBool(rows.get('diagnostics_enabled'))
  const diagVerbose = asBool(rows.get('diagnostics_verbose'))
  const diagPty = asBool(rows.get('diagnostics_include_pty_output'))
  const retention = rows.get('diagnostics_retention_days')
  if (
    diagEnabled !== undefined ||
    diagVerbose !== undefined ||
    diagPty !== undefined ||
    retention !== undefined
  ) {
    out.diagnostics = {
      enabled: diagEnabled,
      verbose: diagVerbose,
      includePtyOutput: diagPty,
      retentionDays: retention !== undefined ? Number(retention) : undefined
    }
  }

  const cliShown = asBool(rows.get('cli_migration_dialog_shown'))
  if (cliShown !== undefined) out.cli = { migrationDialogShown: cliShown }

  return out
}

/** Drop groups whose destination is already populated — never clobber. */
function onlyAbsent(
  patch: Partial<ClientSettings>,
  existing: ClientSettings
): Partial<ClientSettings> {
  const out: Partial<ClientSettings> = {}
  for (const key of Object.keys(patch) as Array<keyof ClientSettings>) {
    if (existing[key] === undefined) (out as Record<string, unknown>)[key] = patch[key]
  }
  return out
}

export type MigrationResult =
  | { status: 'already-migrated' }
  | { status: 'no-source' }
  | { status: 'migrated'; keys: string[] }

/**
 * Runs once per channel. Idempotent, and safe to call before the sidecar exists.
 * Throws only if read-back verification fails — the sentinel is not written then,
 * so the next boot retries.
 */
export async function migrateClientSettings(opts: {
  clientRoot: string
  /** The shared DB file. Absent (e.g. a fresh install) → nothing to migrate. */
  dbPath: string
}): Promise<MigrationResult> {
  const sentinel = sentinelPath(opts.clientRoot)
  if (existsSync(sentinel)) return { status: 'already-migrated' }

  if (!existsSync(opts.dbPath)) {
    writeFileSync(sentinel, new Date().toISOString())
    return { status: 'no-source' }
  }

  const rows = new Map<string, string>()
  const db = new Database(opts.dbPath, { readonly: true })
  try {
    const placeholders = CLIENT_SETTINGS_KEYS.map(() => '?').join(',')
    const found = db
      .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
      .all(...CLIENT_SETTINGS_KEYS) as Array<{ key: string; value: string }>
    for (const r of found) rows.set(r.key, r.value)
  } finally {
    db.close()
  }

  const patch = onlyAbsent(toClientSettings(rows), readClientSettings(opts.clientRoot))
  const keys = Object.keys(patch)
  if (keys.length === 0) {
    writeFileSync(sentinel, new Date().toISOString())
    return { status: 'migrated', keys: [] }
  }

  // AWAITED, deliberately. `updateClientSettings` serializes through a promise
  // chain, so a fire-and-forget call followed by a synchronous read-back would
  // verify the state BEFORE the write — i.e. it would pass while losing data.
  await updateClientSettings(patch, opts.clientRoot)
  const readBack = readClientSettings(opts.clientRoot)
  for (const key of keys) {
    const expected = JSON.stringify((patch as Record<string, unknown>)[key])
    const actual = JSON.stringify((readBack as Record<string, unknown>)[key])
    if (expected !== actual) {
      // NO sentinel. The source rows are untouched, so the next boot retries the
      // whole pass; marking it done here is how settings would be lost for good.
      throw new Error(
        `client-settings migration failed verification for "${key}": wrote ${expected}, read back ${actual}`
      )
    }
  }

  writeFileSync(sentinel, new Date().toISOString())
  return { status: 'migrated', keys }
}
