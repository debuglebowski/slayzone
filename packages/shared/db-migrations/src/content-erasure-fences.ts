import type Database from 'better-sqlite3'

/**
 * The content-erasure write fence: every table with a `task_id` or `tab_id`
 * column gets BEFORE INSERT/UPDATE triggers that abort once that task/tab is in
 * `content_erasure_tasks`/`content_erasure_tabs`, so a late agent hook or editor
 * save cannot recreate erased content.
 *
 * SQLite has no DDL triggers: a table created, or rebuilt (CREATE new + copy +
 * DROP old + RENAME), AFTER the last call to `installContentErasureFences` has
 * no fence. Every migration that creates or rebuilds a table with a `task_id`
 * or `tab_id` column MUST call `installContentErasureFences(db)` as its last
 * step, and a change to a fence definition below needs a new migration that
 * calls it. `content-erasure-fences.test.ts` fails on any unfenced table.
 */

/** Delivery/acknowledgement metadata the erasure commit keeps: offline
 * computers still need their deletion fences. Mirrors the erasure commit's kept
 * tables (`DELIVERY_TABLES` in the content-erasure domain's worker-db). */
export const CONTENT_ERASURE_UNFENCED_TABLES: ReadonlySet<string> = new Set([
  'chat_task_lifecycle',
  'chat_task_computers',
  'chat_lifecycle_acks',
  'chat_ownership',
  'chat_deletion_targets',
  'chat_tab_bindings',
  'chat_provider_bindings',
  'chat_metadata_progress',
  'chat_bootstrap_reservations',
  'chat_unavailable_owners',
  'chat_folder_deletions',
  'chat_folder_deletion_acks',
  // Own fence (`erased_task_cannot_return`), keyed by `id`.
  'tasks'
])

/** The scope `createArtifactBackupProtection` (task-artifacts) pins a retained
 * backup's blobs under. Frozen here: the fence predicate is schema. */
const HUB_BACKUP_PIN_SCOPE = 'hub-backup'

/** Rows of a fenced table that stay writable for erased tasks (SQL over NEW).
 * Backup pins are retention metadata, not content: erasure keeps the bytes a
 * retained backup holds until that backup is gone, so the hub must be able to
 * rebuild that backup's pins (e.g. after a restart). Other pin scopes are live
 * consumers and stay fenced: a late one would keep erased bytes forever. */
const UNFENCED_ROWS: Readonly<Record<string, string>> = {
  artifact_blob_pins: `NEW.scope IS '${HUB_BACKUP_PIN_SCOPE}'`
}

/** `task_artifacts` updates have their own in-flight fence
 * (`erasing_task_has_no_updated_artifacts`), lifted once the DB rows are erased. */
const UNFENCED_ACTIONS: Readonly<Record<string, ReadonlyArray<'INSERT' | 'UPDATE'>>> = {
  task_artifacts: ['UPDATE']
}

export interface ContentErasureFence {
  table: string
  name: string
  /** Exact CREATE TRIGGER text, as `sqlite_master.sql` stores it. */
  sql: string
}

const ident = (name: string) => '"' + name.replaceAll('"', '""') + '"'

/** The fence triggers the current schema of `db` must carry. */
export function contentErasureFences(db: Database.Database): ContentErasureFence[] {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as Array<{ name: string }>
  const fences: ContentErasureFence[] = []
  for (const { name } of tables) {
    if (name.startsWith('content_erasure_') || CONTENT_ERASURE_UNFENCED_TABLES.has(name)) continue
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${ident(name)})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    )
    const conditions: string[] = []
    if (columns.has('task_id'))
      conditions.push('EXISTS(SELECT 1 FROM content_erasure_tasks WHERE task_id=NEW.task_id)')
    if (columns.has('tab_id'))
      conditions.push('EXISTS(SELECT 1 FROM content_erasure_tabs WHERE tab_id=NEW.tab_id)')
    if (!conditions.length) continue
    const exempt = UNFENCED_ROWS[name]
    const when = exempt
      ? `NOT (${exempt}) AND (${conditions.join(' OR ')})`
      : conditions.join(' OR ')
    for (const action of ['INSERT', 'UPDATE'] as const) {
      if (UNFENCED_ACTIONS[name]?.includes(action)) continue
      // Same names as migration 198, so reinstalling replaces its triggers.
      const trigger = ident(`content_erasure_${name}_${action.toLowerCase()}`)
      fences.push({
        table: name,
        name: `content_erasure_${name}_${action.toLowerCase()}`,
        sql: `CREATE TRIGGER ${trigger} BEFORE ${action} ON ${ident(name)} WHEN ${when} BEGIN SELECT RAISE(ABORT,'Content was permanently erased'); END`
      })
    }
  }
  return fences
}

/** (Re)install every fence from the current definition. Idempotent. */
export function installContentErasureFences(db: Database.Database): void {
  for (const fence of contentErasureFences(db)) {
    db.exec(`DROP TRIGGER IF EXISTS ${ident(fence.name)}`)
    db.exec(fence.sql)
  }
}

/** Fences that are absent or differ from the current definition. Empty = fenced. */
export function staleContentErasureFences(db: Database.Database): string[] {
  const installed = new Map(
    (
      db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as Array<{
        name: string
        sql: string
      }>
    ).map((t) => [t.name, t.sql])
  )
  return contentErasureFences(db)
    .filter((fence) => installed.get(fence.name) !== fence.sql)
    .map((fence) => fence.name)
}
