import fs from 'node:fs'
import path from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import { SettingsService, settingProjectId } from '@slayzone/settings/server'
import type { AccessScope } from './access'
import type {
  ImportTxnParams,
  SetTaskParentTxnParams,
  SlayExportData
} from '../txns/export-import-txns'
import { getAppDeps, getNotifyEvents } from './app-deps'

/**
 * Export / import, running where the data is.
 *
 * This whole module lived in `apps/app/src/main` and was reached through seven
 * AppDeps slots — the hub asking the Electron host to read and write the hub's own
 * database. Nothing here needs Electron except picking a file path, which is four
 * calls (`appGetVersion`, `appGetDownloadsDir`, `dialogShowSaveDialog`,
 * `dialogShowOpenDialog`) that already exist as AppDeps slots. So the dependency
 * was exactly backwards: the DB half was hostage to the dialog half.
 *
 * Its named txns moved to `../txns/export-import-txns` in the same change, because
 * the hub's `namedTxn` dispatches against the domain registry only — an app-only
 * txn threw, which is what pinned this to the host in the first place.
 */

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

/**
 * Who is exporting or importing: the request's user and access scope.
 *
 * O-22 (T-101): on a hub with login "everything" is the CALLER's everything — their
 * projects (through `canAccess`, so sharing widens it with no change here), what hangs
 * off them, the hub-wide AI-config library and registries every user sees, and their
 * own view of the settings. Nobody — the admin included — exports another user's rows;
 * the whole hub is backed up at server level, never through the app. Without login
 * (the desktop app's hub) the scope does not enforce and the export is the whole
 * database, exactly as before.
 */
export interface ExportImportCaller {
  /** Who imported projects belong to: the request's user, or null on a hub without login. */
  readonly userId: string | null
  readonly scope: AccessScope
}

async function exportAll(db: SlayzoneDb, caller: ExportImportCaller): Promise<SlayExportBundle> {
  const projectIds = await caller.scope.accessibleProjectIds()
  return {
    meta: {
      version: EXPORT_VERSION,
      appVersion: await getAppDeps().appGetVersion(),
      exportDate: new Date().toISOString(),
      scope: 'all',
      dbVersion: DB_VERSION
    },
    data:
      projectIds === null ? await wholeDatabase(db) : await ownRows(db, projectIds, caller.userId)
  }
}

/** Every row of every exported table: a hub without login. */
async function wholeDatabase(db: SlayzoneDb): Promise<SlayExportData> {
  return {
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

/**
 * The rows of `projectIds` (the caller's) and what hangs off them. A row linking to
 * something outside them — a dependency on another user's task, a tag of another
 * project — is left out, like `exportProject` does. Settings: the caller's own view
 * (hub-wide keys and their own per-user ones; never `internal` ones, another user's,
 * or a project-keyed one of a project not theirs).
 */
async function ownRows(
  db: SlayzoneDb,
  projectIds: readonly string[],
  userId: string | null
): Promise<SlayExportData> {
  const ids = [...projectIds]
  const inProjects = `(${ids.map(() => '?').join(', ')})`
  const ownTasks = `SELECT id FROM tasks WHERE project_id IN ${inProjects}`
  const ownTags = `SELECT id FROM tags WHERE project_id IN ${inProjects}`
  const all = (sql: string, params: unknown[] = ids): Promise<Row[]> =>
    db.all(sql, params) as Promise<Row[]>
  const settings = userId
    ? Object.entries(await SettingsService.forDatabase(db).forUser(userId).getAll())
        .filter(([key]) => {
          const project = settingProjectId(key)
          return project === null || ids.includes(project)
        })
        .map(([key, value]) => ({ key, value }))
    : []
  return {
    projects: await all(`SELECT * FROM projects WHERE id IN ${inProjects}`),
    tasks: await all(`SELECT * FROM tasks WHERE project_id IN ${inProjects}`),
    tags: await all(`SELECT * FROM tags WHERE project_id IN ${inProjects}`),
    task_tags: await all(
      `SELECT * FROM task_tags WHERE task_id IN (${ownTasks}) AND tag_id IN (${ownTags})`,
      [...ids, ...ids]
    ),
    task_dependencies: await all(
      `SELECT * FROM task_dependencies
        WHERE task_id IN (${ownTasks}) AND blocks_task_id IN (${ownTasks})`,
      [...ids, ...ids]
    ),
    terminal_tabs: await all(`SELECT * FROM terminal_tabs WHERE task_id IN (${ownTasks})`),
    // A global library item (no project) is hub-wide: every user sees it (access.ts).
    ai_config_items: await all(
      `SELECT * FROM ai_config_items WHERE project_id IS NULL OR project_id IN ${inProjects}`
    ),
    ai_config_project_selections: await all(
      `SELECT * FROM ai_config_project_selections WHERE project_id IN ${inProjects}`
    ),
    // The skill registries: hub-wide, listed to every user.
    ai_config_sources: await all('SELECT * FROM ai_config_sources', []),
    settings
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
      appVersion: await getAppDeps().appGetVersion(),
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
async function importBundle(
  db: SlayzoneDb,
  bundle: SlayExportBundle,
  caller: ExportImportCaller
): Promise<ImportResult> {
  const result = await db.namedTxn('export-import:import', {
    data: bundle.data,
    ownerUserId: caller.userId,
    projectIds: await caller.scope.accessibleProjectIds()
  } satisfies ImportTxnParams)
  return result
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function doExport(bundle: SlayExportBundle): Promise<ExportResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const defaultName =
    bundle.meta.scope === 'project'
      ? `${(bundle.data.projects[0]?.name as string) ?? 'project'}-${timestamp}.slay`
      : `slayzone-all-${timestamp}.slay`
  const defaultPath = path.join(await getAppDeps().appGetDownloadsDir(), defaultName)

  // Window parenting is the host's business — it owns the BrowserWindow.
  const saveResult = await getAppDeps().dialogShowSaveDialog({
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

async function handleExportAll(db: SlayzoneDb, caller: ExportImportCaller): Promise<ExportResult> {
  try {
    const bundle = await exportAll(db, caller)
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

async function handleImport(db: SlayzoneDb, caller: ExportImportCaller): Promise<ImportResult> {
  try {
    const openResult = await getAppDeps().dialogShowOpenDialog({
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

    const result = await importBundle(db, bundle, caller)

    getNotifyEvents().emit('tasks-changed') // tRPC notify.onTasksChanged source

    return result
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// Pure op surface shared by the IPC handlers (below) and the tRPC
// `app.exportImport` router (via setAppDeps). Test-only ops bypass native
// dialogs and are present only when `isTest` (e2e); the router guards on their
// presence. Both transports delegate here (coexistence until slice 5).
export type ExportImportOps = {
  exportAll: () => Promise<ExportResult>
  exportProject: (projectId: string) => Promise<ExportResult>
  importBundle: () => Promise<ImportResult>
  testExportAllToPath?: (filePath: string) => Promise<ExportResult>
  testExportProjectToPath?: (projectId: string, filePath: string) => Promise<ExportResult>
  testImportFromPath?: (filePath: string) => Promise<ImportResult>
  testSetTaskParent?: (
    taskId: string,
    parentId: string | null
  ) => Promise<{ success: boolean; error?: string }>
}

/**
 * `caller.userId`: who imported projects belong to — the request's user, or null on
 * a hub without login. Required for the same reason as `createProject`'s: an
 * import is a way to create projects, and every such way decides the owner.
 * `caller.scope`: what `exportAll` may hold (see {@link ExportImportCaller}).
 */
export function buildExportImportOps(
  db: SlayzoneDb,
  caller: ExportImportCaller,
  isTest = false
): ExportImportOps {
  const ops: ExportImportOps = {
    exportAll: () => handleExportAll(db, caller),
    exportProject: (projectId: string) => handleExportProject(db, projectId),
    importBundle: () => handleImport(db, caller)
  }

  // Test-only ops that bypass native file dialogs
  if (isTest) {
    ops.testExportAllToPath = async (filePath: string) => {
      try {
        const bundle = await exportAll(db, caller)
        fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8')
        return { success: true, path: filePath }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    ops.testExportProjectToPath = async (projectId: string, filePath: string) => {
      try {
        const bundle = await exportProject(db, projectId)
        fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8')
        return { success: true, path: filePath }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    ops.testImportFromPath = async (filePath: string) => {
      try {
        const raw = fs.readFileSync(filePath, 'utf8')
        const bundle = JSON.parse(raw) as SlayExportBundle
        if (bundle.meta?.version !== EXPORT_VERSION) {
          return { success: false, error: `Unsupported export version: ${bundle.meta?.version}` }
        }
        const result = await importBundle(db, bundle, caller)
        getNotifyEvents().emit('tasks-changed') // tRPC notify.onTasksChanged source
        return result
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    // Test-only: set parent_id directly. Allows tests to simulate stale
    // (orphan) FKs by temporarily disabling FK checks for this single
    // statement. Must not be exposed outside isTest mode. The PRAGMA toggle +
    // UPDATE runs inside the worker via a named txn (the async proxy has no
    // `pragma()`).
    ops.testSetTaskParent = async (taskId: string, parentId: string | null) => {
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
  }

  return ops
}
