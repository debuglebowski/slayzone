import type { IpcMain } from 'electron'
import { app } from 'electron'
import path from 'path'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  CreateProjectInput,
  UpdateProjectInput,
  CreateProjectGroupInput,
  UpdateProjectGroupInput,
  TopLevelEntryRef
} from '@slayzone/projects/shared'
import {
  listAllProjects,
  createProject,
  updateProject,
  deleteProject,
  uploadProjectIcon,
  reorderProjects,
  parseProject
} from '@slayzone/projects/server'

function getProjectIconsDir(): string {
  return path.join(process.env.SLAYZONE_DB_DIR || app.getPath('userData'), 'project-icons')
}

export function registerProjectHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  // Thin IPC wrappers over the electron-free `@slayzone/projects/server` store —
  // the same fns the tRPC projectsRouter calls (single source of truth, coexisting
  // until slice 5). The icon dir is computed here (Electron-main) and injected so
  // the store stays headless-safe.
  const iconsDir = (): string => getProjectIconsDir()

  ipcMain.handle('db:projects:getAll', () => listAllProjects(db))

  ipcMain.handle('db:projects:create', (_, data: CreateProjectInput) => createProject(db, data))

  ipcMain.handle('db:projects:update', (_, data: UpdateProjectInput) =>
    updateProject(db, data, iconsDir())
  )

  ipcMain.handle('db:projects:delete', (_, id: string) => deleteProject(db, id, iconsDir()))

  ipcMain.handle('db:projects:uploadIcon', (_, projectId: string, sourcePath: string) =>
    uploadProjectIcon(db, iconsDir(), projectId, sourcePath)
  )

  ipcMain.handle('db:projects:reorder', (_, projectIds: string[]) =>
    reorderProjects(db, projectIds)
  )

  // ── Project groups ─────────────────────────────────────────────────────────
  // Discord-style folders (rail) + labeled collapsible sections (tree). The
  // complex read-modify-write ordering lives in worker-safe named txns
  // (projects-txns.ts); these handlers stay thin. Mutating ops return an
  // authoritative { projects, groups } snapshot the renderer replaces state with.
  type RawSnapshot = {
    projects: (Record<string, unknown> | undefined)[]
    groups: (Record<string, unknown> | undefined)[]
  }
  const parseSnapshot = (snap: RawSnapshot) => ({
    projects: snap.projects.map((row) => parseProject(row)),
    groups: snap.groups
  })

  ipcMain.handle('db:project-groups:getAll', async () => {
    return db.all<Record<string, unknown>>('SELECT * FROM project_groups ORDER BY sort_order')
  })

  ipcMain.handle('db:project-groups:create', async (_, data: CreateProjectGroupInput) => {
    const now = new Date().toISOString()
    const snap = await db.namedTxn('project-groups:create', {
      id: crypto.randomUUID(),
      name: (data?.name ?? '').trim(),
      createdAt: now,
      updatedAt: now
    })
    return parseSnapshot(snap)
  })

  ipcMain.handle('db:project-groups:createWith', async (_, projectIds: string[]) => {
    if (!Array.isArray(projectIds) || projectIds.length === 0)
      throw new Error('createWith: projectIds must be a non-empty array')
    const now = new Date().toISOString()
    const snap = await db.namedTxn('project-groups:createWith', {
      id: crypto.randomUUID(),
      name: '',
      createdAt: now,
      updatedAt: now,
      projectIds
    })
    return parseSnapshot(snap)
  })

  ipcMain.handle('db:project-groups:update', async (_, data: UpdateProjectGroupInput) => {
    const fields: string[] = []
    const values: unknown[] = []
    if (data.name !== undefined) {
      fields.push('name = ?')
      values.push(data.name.trim())
    }
    if (data.collapsed !== undefined) {
      fields.push('collapsed = ?')
      values.push(data.collapsed ? 1 : 0)
    }
    if (fields.length === 0) {
      return db.get<Record<string, unknown>>('SELECT * FROM project_groups WHERE id = ?', [data.id])
    }
    fields.push("updated_at = datetime('now')")
    values.push(data.id)
    await db.run(`UPDATE project_groups SET ${fields.join(', ')} WHERE id = ?`, values)
    return db.get<Record<string, unknown>>('SELECT * FROM project_groups WHERE id = ?', [data.id])
  })

  ipcMain.handle('db:project-groups:delete', async (_, id: string) => {
    const snap = await db.namedTxn('project-groups:delete', { id })
    return parseSnapshot(snap)
  })

  ipcMain.handle(
    'db:project-groups:moveProject',
    async (_, projectId: string, groupId: string | null, targetIndex: number) => {
      const snap = await db.namedTxn('project-groups:moveProject', {
        projectId,
        groupId: groupId ?? null,
        targetIndex
      })
      return parseSnapshot(snap)
    }
  )

  ipcMain.handle('db:project-groups:reorderTopLevel', async (_, entries: TopLevelEntryRef[]) => {
    if (!Array.isArray(entries)) throw new Error('reorderTopLevel: entries must be an array')
    const snap = await db.namedTxn('project-groups:reorderTopLevel', { entries })
    return parseSnapshot(snap)
  })

  ipcMain.handle(
    'db:project-groups:reorderWithin',
    async (_, groupId: string, projectIds: string[]) => {
      if (!Array.isArray(projectIds))
        throw new Error('reorderWithin: projectIds must be an array')
      const snap = await db.namedTxn('project-groups:reorderWithin', {
        groupId,
        projectIds
      })
      return parseSnapshot(snap)
    }
  )
}
