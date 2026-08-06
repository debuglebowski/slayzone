import type { Database } from 'better-sqlite3'
import type { TxnSigOf } from '@slayzone/platform'
import crypto from 'node:crypto'

/**
 * Named-transaction adapters for export/import.
 *
 * `import` is a conditional read-modify-write that can't be shipped as a static
 * `batchTxn` op list, because it:
 *   - generates UUID remaps, looks up existing tags/projects by name, and loops
 *     until a unique project name is found, THEN inserts based on those reads,
 *   - introspects each table's FK + nullability via PRAGMA (PRAGMAs can't be
 *     parameter-bound), and
 *   - wraps the whole insert in a single transaction with
 *     `PRAGMA defer_foreign_keys = ON` so child-before-parent ordering within
 *     the bundle is allowed (auto-resets at transaction end).
 *
 * `set-task-parent` (test-only) toggles `PRAGMA foreign_keys` around a single
 * UPDATE to deliberately create stale (orphan) FKs — also impossible through
 * the async `SlayzoneDb` proxy (no `pragma()`).
 *
 * Each function receives the worker's SYNCHRONOUS better-sqlite3 `db` and owns
 * its own `db.transaction(...)` where needed — the worker does NOT re-wrap.
 *
 * Pure: imports only better-sqlite3 types + node:crypto — safe to pull into the
 * worker bundle.
 */

type Row = Record<string, unknown>

export interface SlayExportData {
  projects: Row[]
  tasks: Row[]
  tags: Row[]
  task_tags: Row[]
  task_dependencies: Row[]
  terminal_tabs: Row[]
  ai_config_items: Row[]
  ai_config_project_selections: Row[]
  ai_config_sources: Row[]
  settings: Row[]
}

export interface ImportTxnResult {
  success: boolean
  projectCount?: number
  taskCount?: number
  importedProjects?: Array<{ id: string; name: string }>
  error?: string
}

// Columns that are reserved SQL words and need quoting
const RESERVED_COLUMNS = new Set(['order', 'key', 'value', 'group', 'default'])

interface FkColInfo {
  nullable: boolean
}

// Whitelist of tables we import into — used to validate PRAGMA table-name
// interpolation (PRAGMAs don't support parameter binding).
const IMPORT_TABLES = new Set([
  'projects',
  'tasks',
  'tags',
  'task_tags',
  'task_dependencies',
  'terminal_tabs',
  'ai_config_items',
  'ai_config_project_selections',
  'ai_config_sources',
  'settings'
])

function buildFkInfo(db: Database, table: string): Map<string, FkColInfo> {
  if (!IMPORT_TABLES.has(table)) throw new Error(`Unknown import table: ${table}`)
  const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
    from: string
  }>
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string
    notnull: number
  }>
  const nullableByCol = new Map(cols.map((c) => [c.name, c.notnull === 0]))
  const result = new Map<string, FkColInfo>()
  for (const fk of fks) {
    result.set(fk.from, { nullable: nullableByCol.get(fk.from) ?? true })
  }
  return result
}

function insertRow(
  db: Database,
  table: string,
  row: Row,
  remap: Map<string, string>,
  fkInfo: Map<string, FkColInfo>
): void {
  const remapped = { ...row }

  // Remap primary key
  if (remapped.id != null && remap.has(remapped.id as string)) {
    remapped.id = remap.get(remapped.id as string)
  }

  // Remap foreign keys. Cases:
  //   val == null                    → leave null
  //   val in remap                   → rewrite to new id
  //   val not in remap, nullable     → null out stale ref
  //   val not in remap, not-nullable → skip row entirely
  for (const [col, info] of fkInfo) {
    const val = remapped[col]
    if (val == null) continue
    if (remap.has(val as string)) {
      remapped[col] = remap.get(val as string)
    } else if (info.nullable) {
      remapped[col] = null
    } else {
      return
    }
  }

  const cols = Object.keys(remapped)
  const quotedCols = cols.map((c) => (RESERVED_COLUMNS.has(c) ? `"${c}"` : c)).join(', ')
  const placeholders = cols.map(() => '?').join(', ')
  db.prepare(`INSERT INTO ${table} (${quotedCols}) VALUES (${placeholders})`).run(
    ...cols.map((c) => remapped[c])
  )
}

function clearProviderConversationIds(providerConfig: string | null): string | null {
  if (!providerConfig) return providerConfig
  try {
    const parsed = JSON.parse(providerConfig)
    for (const mode of Object.keys(parsed)) {
      if (parsed[mode]?.conversationId) {
        parsed[mode].conversationId = null
      }
    }
    return JSON.stringify(parsed)
  } catch {
    return providerConfig
  }
}

function importBundle(db: Database, data: SlayExportData): ImportTxnResult {
  const remap = new Map<string, string>()

  // Generate new UUIDs for all entities with `id` columns
  for (const p of data.projects) remap.set(p.id as string, crypto.randomUUID())
  for (const t of data.tasks) remap.set(t.id as string, crypto.randomUUID())
  for (const tab of data.terminal_tabs) remap.set(tab.id as string, crypto.randomUUID())
  for (const item of data.ai_config_items) remap.set(item.id as string, crypto.randomUUID())
  for (const sel of data.ai_config_project_selections)
    remap.set(sel.id as string, crypto.randomUUID())

  // Tags: reuse existing by name, new UUID otherwise
  for (const tag of data.tags) {
    const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(tag.name as string) as
      | { id: string }
      | undefined
    remap.set(tag.id as string, existing ? existing.id : crypto.randomUUID())
  }

  // Handle project name collisions — loop until unique
  for (const p of data.projects) {
    let name = p.name as string
    while (db.prepare('SELECT id FROM projects WHERE name = ?').get(name)) {
      name = `${name} (imported)`
    }
    p.name = name
  }

  // Clean non-portable task fields
  for (const t of data.tasks) {
    t.worktree_path = null
    t.worktree_parent_branch = null
    t.merge_state = null
    t.merge_context = null
    t.provider_config = clearProviderConversationIds(t.provider_config as string | null)
    // Clear legacy conversation ID columns too
    if ('claude_conversation_id' in t) t.claude_conversation_id = null
    if ('codex_conversation_id' in t) t.codex_conversation_id = null
    if ('cursor_conversation_id' in t) t.cursor_conversation_id = null
    if ('gemini_conversation_id' in t) t.gemini_conversation_id = null
    if ('opencode_conversation_id' in t) t.opencode_conversation_id = null
  }

  const fkInfoByTable = new Map<string, Map<string, FkColInfo>>()
  const fkInfo = (table: string): Map<string, FkColInfo> => {
    let info = fkInfoByTable.get(table)
    if (!info) {
      info = buildFkInfo(db, table)
      fkInfoByTable.set(table, info)
    }
    return info
  }

  const insertAll = db.transaction(() => {
    // Defer FK checks to COMMIT so insertion order within this transaction
    // doesn't matter (e.g. child task whose parent appears later in the
    // bundle). Auto-resets at transaction end.
    db.pragma('defer_foreign_keys = ON')

    for (const p of data.projects) insertRow(db, 'projects', p, remap, fkInfo('projects'))

    for (const t of data.tasks) insertRow(db, 'tasks', t, remap, fkInfo('tasks'))

    for (const tag of data.tags) {
      const newId = remap.get(tag.id as string)!
      const exists = db.prepare('SELECT id FROM tags WHERE id = ?').get(newId)
      if (!exists) insertRow(db, 'tags', tag, remap, fkInfo('tags'))
    }

    for (const tt of data.task_tags) insertRow(db, 'task_tags', tt, remap, fkInfo('task_tags'))

    for (const dep of data.task_dependencies)
      insertRow(db, 'task_dependencies', dep, remap, fkInfo('task_dependencies'))

    for (const tab of data.terminal_tabs)
      insertRow(db, 'terminal_tabs', tab, remap, fkInfo('terminal_tabs'))

    for (const item of data.ai_config_items)
      insertRow(db, 'ai_config_items', item, remap, fkInfo('ai_config_items'))

    for (const sel of data.ai_config_project_selections)
      insertRow(
        db,
        'ai_config_project_selections',
        sel,
        remap,
        fkInfo('ai_config_project_selections')
      )

    // Settings (all-export only, don't overwrite existing)
    for (const s of data.settings) {
      const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(s.key as string)
      if (!exists) insertRow(db, 'settings', s, remap, fkInfo('settings'))
    }

    // AI config sources (all-export only, don't overwrite existing)
    for (const src of data.ai_config_sources) {
      const exists = db
        .prepare('SELECT id FROM ai_config_sources WHERE id = ?')
        .get(src.id as string)
      if (!exists) {
        remap.set(src.id as string, crypto.randomUUID())
        insertRow(db, 'ai_config_sources', src, remap, fkInfo('ai_config_sources'))
      }
    }
  })

  insertAll()

  const importedProjects = data.projects.map((p) => ({
    id: remap.get(p.id as string) ?? (p.id as string),
    name: p.name as string
  }))

  return {
    success: true,
    projectCount: data.projects.length,
    taskCount: data.tasks.length,
    importedProjects
  }
}

export interface ImportTxnParams {
  data: SlayExportData
}

export interface SetTaskParentTxnParams {
  taskId: string
  parentId: string | null
}

export const exportImportTxns = {
  'export-import:import': (db: Database, p: ImportTxnParams): ImportTxnResult =>
    importBundle(db, p.data),

  // Test-only: set parent_id directly. Allows tests to simulate stale (orphan)
  // FKs by temporarily disabling FK checks for this single statement. Must not
  // be exposed outside isTest mode.
  'export-import:set-task-parent': (db: Database, p: SetTaskParentTxnParams): { success: true } => {
    db.pragma('foreign_keys = OFF')
    try {
      db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(p.parentId, p.taskId)
    } finally {
      db.pragma('foreign_keys = ON')
    }
    return { success: true }
  }
}

declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof exportImportTxns> {}
}
