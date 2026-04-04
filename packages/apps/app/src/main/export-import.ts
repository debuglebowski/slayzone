import { app, dialog, BrowserWindow, type IpcMain } from 'electron'
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

// Columns that reference other entity IDs and need remapping.
// value = true means nullable (skip remap if null), false = required
const FK_MAP: Record<string, Record<string, boolean>> = {
  tasks: { project_id: false, parent_id: true },
  task_tags: { task_id: false, tag_id: false },
  task_dependencies: { task_id: false, blocks_task_id: false },
  terminal_tabs: { task_id: false },
  ai_config_items: { project_id: true },
  ai_config_project_selections: { project_id: false, item_id: false }
}

// Columns that are reserved SQL words and need quoting
const RESERVED_COLUMNS = new Set(['order', 'key', 'value', 'group', 'default'])

function insertRow(db: Database, table: string, row: Row, remap: Map<string, string>): void {
  const remapped = { ...row }

  // Remap primary key
  if (remapped.id != null && remap.has(remapped.id as string)) {
    remapped.id = remap.get(remapped.id as string)
  }

  // Remap foreign keys
  const fks = FK_MAP[table]
  if (fks) {
    for (const [col, nullable] of Object.entries(fks)) {
      const val = remapped[col]
      if (val == null) continue
      if (remap.has(val as string)) {
        remapped[col] = remap.get(val as string)
      } else if (!nullable) {
        // FK target not in remap — skip this row
        return
      }
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

  const insertAll = db.transaction(() => {
    // 1. Projects
    for (const p of data.projects) insertRow(db, 'projects', p, remap)

    // 2. Tasks (parent_id may reference other tasks — order doesn't matter
    //    since we defer FK checks within the transaction)
    for (const t of data.tasks) insertRow(db, 'tasks', t, remap)

    // 3. Tags (skip if already exists — reused via remap)
    for (const tag of data.tags) {
      const newId = remap.get(tag.id as string)!
      const exists = db.prepare('SELECT id FROM tags WHERE id = ?').get(newId)
      if (!exists) insertRow(db, 'tags', tag, remap)
    }

    // 4. Task tags
    for (const tt of data.task_tags) insertRow(db, 'task_tags', tt, remap)

    // 5. Task dependencies
    for (const dep of data.task_dependencies) insertRow(db, 'task_dependencies', dep, remap)

    // 6. Terminal tabs
    for (const tab of data.terminal_tabs) insertRow(db, 'terminal_tabs', tab, remap)

    // 7. AI config items
    for (const item of data.ai_config_items) insertRow(db, 'ai_config_items', item, remap)

    // 8. AI config project selections
    for (const sel of data.ai_config_project_selections)
      insertRow(db, 'ai_config_project_selections', sel, remap)

    // 9. Settings (all-export only, don't overwrite existing)
    for (const s of data.settings) {
      const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(s.key as string)
      if (!exists) insertRow(db, 'settings', s, remap)
    }

    // 10. AI config sources (all-export only, don't overwrite existing)
    for (const src of data.ai_config_sources) {
      const exists = db.prepare('SELECT id FROM ai_config_sources WHERE id = ?').get(src.id as string)
      if (!exists) {
        remap.set(src.id as string, crypto.randomUUID())
        insertRow(db, 'ai_config_sources', src, remap)
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

export function registerExportImportHandlers(ipcMain: IpcMain, db: Database, isTest = false): void {
  ipcMain.handle('export-import:export-all', () => handleExportAll(db))
  ipcMain.handle('export-import:export-project', (_, projectId: string) => handleExportProject(db, projectId))
  ipcMain.handle('export-import:import', () => handleImport(db))

  // Test-only handlers that bypass native file dialogs
  if (isTest) {
    ipcMain.handle('export-import:test:export-all-to-path', (_, filePath: string) => {
      try {
        const bundle = exportAll(db)
        fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8')
        return { success: true, path: filePath }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    })

    ipcMain.handle('export-import:test:export-project-to-path', (_, projectId: string, filePath: string) => {
      try {
        const bundle = exportProject(db, projectId)
        fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8')
        return { success: true, path: filePath }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    })

    ipcMain.handle('export-import:test:import-from-path', (_, filePath: string) => {
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
    })
  }
}
