import { app, dialog, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'better-sqlite3'

// ── Types ────────────────────────────────────────────────────────────────────

const EXPORT_VERSION = 1
const DB_VERSION = 36

type Row = Record<string, unknown>

interface SlayExportMeta {
  version: number
  appVersion: string
  exportDate: string
  scope: 'all' | 'project'
  projectId?: string
  dbVersion: number
}

interface SlayExportData {
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

interface SlayExportBundle {
  meta: SlayExportMeta
  data: SlayExportData
}

interface ExportResult {
  success: boolean
  canceled?: boolean
  path?: string
  error?: string
}

interface ImportResult {
  success: boolean
  canceled?: boolean
  projectCount?: number
  taskCount?: number
  importedProjects?: Array<{ id: string; name: string }>
  error?: string
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportAll(db: Database): SlayExportBundle {
  return {
    meta: {
      version: EXPORT_VERSION,
      appVersion: app.getVersion(),
      exportDate: new Date().toISOString(),
      scope: 'all',
      dbVersion: DB_VERSION
    },
    data: {
      projects: db.prepare('SELECT * FROM projects').all() as Row[],
      tasks: db.prepare('SELECT * FROM tasks').all() as Row[],
      tags: db.prepare('SELECT * FROM tags').all() as Row[],
      task_tags: db.prepare('SELECT * FROM task_tags').all() as Row[],
      task_dependencies: db.prepare('SELECT * FROM task_dependencies').all() as Row[],
      terminal_tabs: db.prepare('SELECT * FROM terminal_tabs').all() as Row[],
      ai_config_items: db.prepare('SELECT * FROM ai_config_items').all() as Row[],
      ai_config_project_selections: db.prepare('SELECT * FROM ai_config_project_selections').all() as Row[],
      ai_config_sources: db.prepare('SELECT * FROM ai_config_sources').all() as Row[],
      settings: db.prepare('SELECT * FROM settings').all() as Row[]
    }
  }
}

function exportProject(db: Database, projectId: string): SlayExportBundle {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined
  if (!project) throw new Error(`Project ${projectId} not found`)

  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(projectId) as Row[]
  const taskIds = tasks.map((t) => t.id as string)

  let taskTags: Row[] = []
  let taskDeps: Row[] = []
  let terminalTabs: Row[] = []
  let tags: Row[] = []

  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(', ')

    taskTags = db
      .prepare(`SELECT * FROM task_tags WHERE task_id IN (${placeholders})`)
      .all(...taskIds) as Row[]

    // Only include dependencies where both tasks are in this project
    taskDeps = db
      .prepare(
        `SELECT * FROM task_dependencies WHERE task_id IN (${placeholders}) AND blocks_task_id IN (${placeholders})`
      )
      .all(...taskIds, ...taskIds) as Row[]

    terminalTabs = db
      .prepare(`SELECT * FROM terminal_tabs WHERE task_id IN (${placeholders})`)
      .all(...taskIds) as Row[]

    // Only tags actually used by these tasks
    const tagIds = [...new Set(taskTags.map((tt) => tt.tag_id as string))]
    if (tagIds.length > 0) {
      const tagPlaceholders = tagIds.map(() => '?').join(', ')
      tags = db.prepare(`SELECT * FROM tags WHERE id IN (${tagPlaceholders})`).all(...tagIds) as Row[]
    }
  }

  const aiConfigItems = db
    .prepare('SELECT * FROM ai_config_items WHERE project_id = ?')
    .all(projectId) as Row[]
  const aiConfigSelections = db
    .prepare('SELECT * FROM ai_config_project_selections WHERE project_id = ?')
    .all(projectId) as Row[]

  return {
    meta: {
      version: EXPORT_VERSION,
      appVersion: app.getVersion(),
      exportDate: new Date().toISOString(),
      scope: 'project',
      projectId,
      dbVersion: DB_VERSION
    },
    data: {
      projects: [project],
      tasks,
      tags,
      task_tags: taskTags,
      task_dependencies: taskDeps,
      terminal_tabs: terminalTabs,
      ai_config_items: aiConfigItems,
      ai_config_project_selections: aiConfigSelections,
      ai_config_sources: [],
      settings: []
    }
  }
}

// ── Import ───────────────────────────────────────────────────────────────────

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

function importBundle(db: Database, bundle: SlayExportBundle): ImportResult {
  const { data } = bundle
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
    const existing = db
      .prepare('SELECT id FROM tags WHERE name = ?')
      .get(tag.name as string) as { id: string } | undefined
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

    for (const tt of data.task_tags)
      insertRow(db, 'task_tags', tt, remap, fkInfo('task_tags'))

    for (const dep of data.task_dependencies)
      insertRow(db, 'task_dependencies', dep, remap, fkInfo('task_dependencies'))

    for (const tab of data.terminal_tabs)
      insertRow(db, 'terminal_tabs', tab, remap, fkInfo('terminal_tabs'))

    for (const item of data.ai_config_items)
      insertRow(db, 'ai_config_items', item, remap, fkInfo('ai_config_items'))

    for (const sel of data.ai_config_project_selections)
      insertRow(db, 'ai_config_project_selections', sel, remap, fkInfo('ai_config_project_selections'))

    // Settings (all-export only, don't overwrite existing)
    for (const s of data.settings) {
      const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(s.key as string)
      if (!exists) insertRow(db, 'settings', s, remap, fkInfo('settings'))
    }

    // AI config sources (all-export only, don't overwrite existing)
    for (const src of data.ai_config_sources) {
      const exists = db.prepare('SELECT id FROM ai_config_sources WHERE id = ?').get(src.id as string)
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

// ── Handlers ─────────────────────────────────────────────────────────────────

function getWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
}

async function doExport(bundle: SlayExportBundle): Promise<ExportResult> {
  const win = getWindow()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const defaultName =
    bundle.meta.scope === 'project'
      ? `${(bundle.data.projects[0]?.name as string) ?? 'project'}-${timestamp}.slay`
      : `slayzone-all-${timestamp}.slay`
  const defaultPath = path.join(app.getPath('downloads'), defaultName)

  const saveResult = win
    ? await dialog.showSaveDialog(win, {
        title: 'Export',
        defaultPath,
        filters: [{ name: 'SlayZone', extensions: ['slay'] }]
      })
    : await dialog.showSaveDialog({
        title: 'Export',
        defaultPath,
        filters: [{ name: 'SlayZone', extensions: ['slay'] }]
      })

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: false, canceled: true }
  }

  fs.writeFileSync(saveResult.filePath, JSON.stringify(bundle, null, 2), 'utf8')
  return { success: true, path: saveResult.filePath }
}

async function handleExportAll(db: Database): Promise<ExportResult> {
  try {
    const bundle = exportAll(db)
    return await doExport(bundle)
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

async function handleExportProject(db: Database, projectId: string): Promise<ExportResult> {
  try {
    const bundle = exportProject(db, projectId)
    return await doExport(bundle)
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

async function handleImport(db: Database): Promise<ImportResult> {
  try {
    const win = getWindow()
    const openResult = win
      ? await dialog.showOpenDialog(win, {
          title: 'Import',
          filters: [{ name: 'SlayZone', extensions: ['slay'] }],
          properties: ['openFile']
        })
      : await dialog.showOpenDialog({
          title: 'Import',
          filters: [{ name: 'SlayZone', extensions: ['slay'] }],
          properties: ['openFile']
        })

    if (openResult.canceled || openResult.filePaths.length === 0) {
      return { success: false, canceled: true }
    }

    const raw = fs.readFileSync(openResult.filePaths[0], 'utf8')
    const bundle = JSON.parse(raw) as SlayExportBundle

    if (bundle.meta?.version !== EXPORT_VERSION) {
      return { success: false, error: `Unsupported export version: ${bundle.meta?.version}` }
    }

    const result = importBundle(db, bundle)

    // Notify renderer to refresh
    const mainWin = BrowserWindow.getAllWindows()[0]
    if (mainWin) mainWin.webContents.send('tasks:changed')

    return result
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export function buildExportImportOps(db: Database, isTest = false) {
  const base = {
    exportAll: () => handleExportAll(db),
    exportProject: (projectId: string) => handleExportProject(db, projectId),
    importBundle: () => handleImport(db),
  }
  if (!isTest) return base
  return {
    ...base,
    testExportAllToPath: (filePath: string) => {
      try {
        const bundle = exportAll(db)
        fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8')
        return { success: true, path: filePath }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
    testExportProjectToPath: (projectId: string, filePath: string) => {
      try {
        const bundle = exportProject(db, projectId)
        fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8')
        return { success: true, path: filePath }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
    testImportFromPath: (filePath: string) => {
      try {
        const raw = fs.readFileSync(filePath, 'utf8')
        const bundle = JSON.parse(raw) as SlayExportBundle
        if (bundle.meta?.version !== EXPORT_VERSION) {
          return { success: false, error: `Unsupported export version: ${bundle.meta?.version}` }
        }
        const result = importBundle(db, bundle)
        const mainWin = BrowserWindow.getAllWindows()[0]
        if (mainWin) mainWin.webContents.send('tasks:changed')
        return result
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
    testSetTaskParent: (taskId: string, parentId: string | null) => {
      try {
        db.pragma('foreign_keys = OFF')
        try {
          db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(parentId, taskId)
        } finally {
          db.pragma('foreign_keys = ON')
        }
        return { success: true }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
  }
}
