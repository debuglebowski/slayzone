import { app, dialog, BrowserWindow, type IpcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  ImportTxnParams,
  SetTaskParentTxnParams,
  SlayExportData
} from './export-import-txns'
import { notifyEvents } from './notify-renderer'

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

async function exportAll(db: SlayzoneDb): Promise<SlayExportBundle> {
  return {
    meta: {
      version: EXPORT_VERSION,
      appVersion: app.getVersion(),
      exportDate: new Date().toISOString(),
      scope: 'all',
      dbVersion: DB_VERSION
    },
    data: {
      projects: (await db.all('SELECT * FROM projects')) as Row[],
      tasks: (await db.all('SELECT * FROM tasks')) as Row[],
      tags: (await db.all('SELECT * FROM tags')) as Row[],
      task_tags: (await db.all('SELECT * FROM task_tags')) as Row[],
      task_dependencies: (await db.all('SELECT * FROM task_dependencies')) as Row[],
      terminal_tabs: (await db.all('SELECT * FROM terminal_tabs')) as Row[],
      ai_config_items: (await db.all('SELECT * FROM ai_config_items')) as Row[],
      ai_config_project_selections: (await db.all(
        'SELECT * FROM ai_config_project_selections'
      )) as Row[],
      ai_config_sources: (await db.all('SELECT * FROM ai_config_sources')) as Row[],
      settings: (await db.all('SELECT * FROM settings')) as Row[]
    }
  }
}

async function exportProject(db: SlayzoneDb, projectId: string): Promise<SlayExportBundle> {
  const project = (await db.get('SELECT * FROM projects WHERE id = ?', [projectId])) as
    | Row
    | undefined
  if (!project) throw new Error(`Project ${projectId} not found`)

  const tasks = (await db.all('SELECT * FROM tasks WHERE project_id = ?', [projectId])) as Row[]
  const taskIds = tasks.map((t) => t.id as string)

  let taskTags: Row[] = []
  let taskDeps: Row[] = []
  let terminalTabs: Row[] = []
  let tags: Row[] = []

  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(', ')

    taskTags = (await db.all(
      `SELECT * FROM task_tags WHERE task_id IN (${placeholders})`,
      taskIds
    )) as Row[]

    // Only include dependencies where both tasks are in this project
    taskDeps = (await db.all(
      `SELECT * FROM task_dependencies WHERE task_id IN (${placeholders}) AND blocks_task_id IN (${placeholders})`,
      [...taskIds, ...taskIds]
    )) as Row[]

    terminalTabs = (await db.all(
      `SELECT * FROM terminal_tabs WHERE task_id IN (${placeholders})`,
      taskIds
    )) as Row[]

    // Only tags actually used by these tasks
    const tagIds = [...new Set(taskTags.map((tt) => tt.tag_id as string))]
    if (tagIds.length > 0) {
      const tagPlaceholders = tagIds.map(() => '?').join(', ')
      tags = (await db.all(`SELECT * FROM tags WHERE id IN (${tagPlaceholders})`, tagIds)) as Row[]
    }
  }

  const aiConfigItems = (await db.all('SELECT * FROM ai_config_items WHERE project_id = ?', [
    projectId
  ])) as Row[]
  const aiConfigSelections = (await db.all(
    'SELECT * FROM ai_config_project_selections WHERE project_id = ?',
    [projectId]
  )) as Row[]

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

// The actual remap/insert logic is a conditional read-modify-write that must
// run atomically inside the DB worker — see `export-import-txns.ts`. Here we
// just hand the bundle data to the named transaction and reshape the result.
async function importBundle(db: SlayzoneDb, bundle: SlayExportBundle): Promise<ImportResult> {
  const result = await db.namedTxn('export-import:import', {
    data: bundle.data
  } satisfies ImportTxnParams)
  return result
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

async function handleExportAll(db: SlayzoneDb): Promise<ExportResult> {
  try {
    const bundle = await exportAll(db)
    return await doExport(bundle)
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

async function handleExportProject(db: SlayzoneDb, projectId: string): Promise<ExportResult> {
  try {
    const bundle = await exportProject(db, projectId)
    return await doExport(bundle)
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

async function handleImport(db: SlayzoneDb): Promise<ImportResult> {
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

    const result = await importBundle(db, bundle)

    // Notify renderer to refresh
    const mainWin = BrowserWindow.getAllWindows()[0]
    notifyEvents.emit('tasks-changed') // tRPC notify.onTasksChanged source
    if (mainWin) mainWin.webContents.send('tasks:changed') // legacy IPC (slice 5 drops)

    return result
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export function registerExportImportHandlers(
  ipcMain: IpcMain,
  db: SlayzoneDb,
  isTest = false
): void {
  ipcMain.handle('export-import:export-all', () => handleExportAll(db))
  ipcMain.handle('export-import:export-project', (_, projectId: string) =>
    handleExportProject(db, projectId)
  )
  ipcMain.handle('export-import:import', () => handleImport(db))

  // Test-only handlers that bypass native file dialogs
  if (isTest) {
    ipcMain.handle('export-import:test:export-all-to-path', async (_, filePath: string) => {
      try {
        const bundle = await exportAll(db)
        fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8')
        return { success: true, path: filePath }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    })

    ipcMain.handle(
      'export-import:test:export-project-to-path',
      async (_, projectId: string, filePath: string) => {
        try {
          const bundle = await exportProject(db, projectId)
          fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8')
          return { success: true, path: filePath }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
    )

    ipcMain.handle('export-import:test:import-from-path', async (_, filePath: string) => {
      try {
        const raw = fs.readFileSync(filePath, 'utf8')
        const bundle = JSON.parse(raw) as SlayExportBundle
        if (bundle.meta?.version !== EXPORT_VERSION) {
          return { success: false, error: `Unsupported export version: ${bundle.meta?.version}` }
        }
        const result = await importBundle(db, bundle)
        const mainWin = BrowserWindow.getAllWindows()[0]
        notifyEvents.emit('tasks-changed') // tRPC notify.onTasksChanged source
        if (mainWin) mainWin.webContents.send('tasks:changed') // legacy IPC (slice 5 drops)
        return result
      } catch (e) {
        return { success: false, error: String(e) }
      }
    })

    // Test-only: set parent_id directly. Allows tests to simulate stale
    // (orphan) FKs by temporarily disabling FK checks for this single
    // statement. Must not be exposed outside isTest mode. The PRAGMA toggle +
    // UPDATE runs inside the worker via a named txn (the async proxy has no
    // `pragma()`).
    ipcMain.handle(
      'export-import:test:set-task-parent',
      async (_, taskId: string, parentId: string | null) => {
        try {
          await db.namedTxn('export-import:set-task-parent', {
            taskId,
            parentId
          } satisfies SetTaskParentTxnParams)
          return { success: true }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
    )
  }
}
