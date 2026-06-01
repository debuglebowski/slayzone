import type Database from 'better-sqlite3'

/**
 * Synchronous integration schema setup — pure (better-sqlite3 only), so it runs
 * inside the DB worker. Single source of truth for the integration tables:
 * the async `ensureIntegrationSchema(db: SlayzoneDb)` registration path routes
 * here via the `integrations:ensure-schema` named transaction, and the
 * Playwright `db:reset-for-test` worker txn calls it directly.
 */
function columnExists(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return columns.some((c) => c.name === column)
}

export function ensureIntegrationSchemaSync(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_synced_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integration_connections_provider
      ON integration_connections(provider, updated_at);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_project_mappings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      external_team_id TEXT NOT NULL,
      external_team_key TEXT NOT NULL,
      external_project_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_integration_project_mappings_connection
      ON integration_project_mappings(connection_id);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_project_connections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_integration_project_connections_connection
      ON integration_project_connections(connection_id);
  `)

  if (!columnExists(db, 'integration_project_mappings', 'sync_mode')) {
    db.exec(
      `ALTER TABLE integration_project_mappings ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'one_way';`
    )
  }

  if (!columnExists(db, 'integration_project_mappings', 'status_setup_complete')) {
    db.exec(
      `ALTER TABLE integration_project_mappings ADD COLUMN status_setup_complete INTEGER NOT NULL DEFAULT 0;`
    )
  }

  if (!columnExists(db, 'integration_connections', 'auth_error')) {
    db.exec(`ALTER TABLE integration_connections ADD COLUMN auth_error TEXT DEFAULT NULL;`)
  }

  if (!columnExists(db, 'integration_connections', 'auth_error_at')) {
    db.exec(`ALTER TABLE integration_connections ADD COLUMN auth_error_at TEXT DEFAULT NULL;`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS external_links (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      external_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_key TEXT NOT NULL,
      external_url TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      sync_state TEXT NOT NULL DEFAULT 'active',
      last_sync_at TEXT DEFAULT NULL,
      last_error TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, connection_id, external_id),
      UNIQUE(provider, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_external_links_connection_state
      ON external_links(connection_id, sync_state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_external_links_task
      ON external_links(task_id);

    CREATE TABLE IF NOT EXISTS external_field_state (
      id TEXT PRIMARY KEY,
      external_link_id TEXT NOT NULL REFERENCES external_links(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      last_local_value_json TEXT NOT NULL DEFAULT 'null',
      last_external_value_json TEXT NOT NULL DEFAULT 'null',
      last_local_updated_at TEXT NOT NULL,
      last_external_updated_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(external_link_id, field_name)
    );
    CREATE INDEX IF NOT EXISTS idx_external_field_state_link
      ON external_field_state(external_link_id);

    CREATE TABLE IF NOT EXISTS integration_state_mappings (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      project_mapping_id TEXT NOT NULL REFERENCES integration_project_mappings(id) ON DELETE CASCADE,
      local_status TEXT NOT NULL,
      state_id TEXT NOT NULL,
      state_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, project_mapping_id, local_status)
    );
  `)
}
