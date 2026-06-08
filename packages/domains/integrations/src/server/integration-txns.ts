import type { Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  IntegrationProvider,
  SetProjectConnectionInput,
  SetProjectMappingInput,
  IntegrationSyncMode
} from '../shared/types'
import { ensureIntegrationSchemaSync } from './schema'

/**
 * Named-transaction adapters for the integrations domain. These are the
 * conditional read-modify-write operations (read an existing row id, then
 * upsert; count usages, then conditionally delete; clear-then-reinsert) that
 * can't be expressed as a static `batchTxn` op list — the dependent write
 * branches on a value read in the same transaction, so they must run as a
 * single function inside the DB worker to stay atomic and race-free.
 *
 * `db` is the worker's synchronous better-sqlite3 handle. Each entry owns its
 * own `db.transaction(...)`, so the worker invokes these directly and does NOT
 * re-wrap them.
 *
 * Pure: imports only better-sqlite3 (type-only) + this domain's pure shared
 * types, so it is safe to pull into the worker bundle (unlike the
 * electron-laden `/main` barrel).
 *
 * Registered into the worker's txn registry via the narrow
 * `@slayzone/integrations/db` entry — never the `/main` barrel.
 */

// Mirror of credentials.ts `toSettingKey` — the worker can't call the async
// `deleteCredential`, so the credential row is removed inline by key here.
function credentialSettingKey(ref: string): string {
  return `integration:credential:${ref}`
}

/** Upsert the project→connection row, reusing the existing row id when present. */
function setProjectConnectionSync(db: Database, input: SetProjectConnectionInput): void {
  const existing = db
    .prepare(`
    SELECT id
    FROM integration_project_connections
    WHERE project_id = ? AND provider = ?
  `)
    .get(input.projectId, input.provider) as { id: string } | undefined

  db.prepare(`
    INSERT INTO integration_project_connections (
      id, project_id, provider, connection_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(project_id, provider) DO UPDATE SET
      connection_id = excluded.connection_id,
      updated_at = datetime('now')
  `).run(existing?.id ?? randomUUID(), input.projectId, input.provider, input.connectionId)
}

/** Cascade-delete all of a provider's data scoped to a single project. */
function clearProjectProviderDataSync(
  db: Database,
  projectId: string,
  provider: IntegrationProvider
): void {
  db.prepare(`
    DELETE FROM integration_state_mappings
    WHERE project_mapping_id IN (
      SELECT id FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    )
  `).run(projectId, provider)

  db.prepare(`
    DELETE FROM integration_project_mappings
    WHERE project_id = ? AND provider = ?
  `).run(projectId, provider)

  db.prepare(`
    DELETE FROM external_field_state
    WHERE external_link_id IN (
      SELECT el.id FROM external_links el
      JOIN tasks t ON t.id = el.task_id
      WHERE el.provider = ? AND t.project_id = ?
    )
  `).run(provider, projectId)

  db.prepare(`
    DELETE FROM external_links
    WHERE provider = ? AND task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )
  `).run(provider, projectId)
}

/** Delete a connection (and its credential row) only when nothing references it. */
function tryDeleteConnectionIfUnusedSync(db: Database, connectionId: string): void {
  const usage = db
    .prepare(`
    SELECT
      (SELECT COUNT(*) FROM integration_project_connections WHERE connection_id = ?) +
      (SELECT COUNT(*) FROM integration_project_mappings WHERE connection_id = ?) +
      (SELECT COUNT(*) FROM external_links WHERE connection_id = ?) AS total
  `)
    .get(connectionId, connectionId, connectionId) as { total: number } | undefined

  if (!usage || usage.total > 0) {
    return
  }

  const connection = db
    .prepare('SELECT credential_ref FROM integration_connections WHERE id = ?')
    .get(connectionId) as { credential_ref: string } | undefined
  if (!connection) {
    return
  }

  db.prepare('DELETE FROM settings WHERE key = ?').run(credentialSettingKey(connection.credential_ref))
  db.prepare('DELETE FROM integration_connections WHERE id = ?').run(connectionId)
}

export interface SetProjectMappingTxnParams {
  input: SetProjectMappingInput
  /** Sibling provider whose project-scoped data is cleared first. */
  otherProvider: IntegrationProvider
}

export const integrationTxns = {
  // ensure-schema: create the integration tables (idempotent DDL). Single source
  // of truth in schema.ts; the async registration-time wrapper routes here.
  'integrations:ensure-schema': (db: Database): null => {
    ensureIntegrationSchemaSync(db)
    return null
  },

  // set-project-connection: read existing row id, then upsert (idempotent on the
  // (project_id, provider) UNIQUE key).
  'integrations:set-project-connection': (db: Database, p: SetProjectConnectionInput): null => {
    db.transaction(() => {
      setProjectConnectionSync(db, p)
    })()
    return null
  },

  // clear-project-connection: cascade-clear the provider's project data, drop the
  // project→connection row, then GC the connection if it is now unreferenced
  // (count-then-conditional-delete).
  'integrations:clear-project-connection': (
    db: Database,
    p: { projectId: string; provider: IntegrationProvider; connectionId: string | null }
  ): null => {
    db.transaction(() => {
      clearProjectProviderDataSync(db, p.projectId, p.provider)
      db.prepare(`
        DELETE FROM integration_project_connections
        WHERE project_id = ? AND provider = ?
      `).run(p.projectId, p.provider)
      if (p.connectionId) {
        tryDeleteConnectionIfUnusedSync(db, p.connectionId)
      }
    })()
    return null
  },

  // set-project-mapping: clear the sibling provider's project data, (re)point the
  // project→connection row, then upsert the mapping. Reads the existing mapping id
  // to reuse it, so the dependent INSERT can't be a static op list. Returns the
  // mapping id the caller needs for the follow-up state-mapping refresh.
  'integrations:set-project-mapping': (db: Database, p: SetProjectMappingTxnParams): string => {
    const { input, otherProvider } = p
    return db.transaction(() => {
      const existing = db
        .prepare(`
        SELECT id FROM integration_project_mappings
        WHERE provider = ? AND project_id = ?
      `)
        .get(input.provider, input.projectId) as { id: string } | undefined
      const mappingId = existing?.id ?? randomUUID()

      clearProjectProviderDataSync(db, input.projectId, otherProvider)
      setProjectConnectionSync(db, {
        projectId: input.projectId,
        provider: input.provider,
        connectionId: input.connectionId
      })
      db.prepare(`
        INSERT INTO integration_project_mappings (
          id, project_id, provider, connection_id, external_team_id, external_team_key, external_project_id, sync_mode, assigned_to_me, external_repo_owner, external_repo_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(project_id, provider) DO UPDATE SET
          connection_id = excluded.connection_id,
          external_team_id = excluded.external_team_id,
          external_team_key = excluded.external_team_key,
          external_project_id = excluded.external_project_id,
          sync_mode = excluded.sync_mode,
          assigned_to_me = excluded.assigned_to_me,
          external_repo_owner = excluded.external_repo_owner,
          external_repo_name = excluded.external_repo_name,
          updated_at = datetime('now')
      `).run(
        mappingId,
        input.projectId,
        input.provider,
        input.connectionId,
        input.externalTeamId,
        input.externalTeamKey,
        input.externalProjectId ?? null,
        (input.syncMode ?? 'one_way') satisfies IntegrationSyncMode,
        input.assignedToMe ? 1 : 0,
        input.externalRepoOwner ?? null,
        input.externalRepoName ?? null
      )

      return mappingId
    })()
  }
}
