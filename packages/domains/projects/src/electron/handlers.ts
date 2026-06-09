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
  listProjectGroups,
  createProjectGroup,
  createFolderWithProjects,
  updateProjectGroup,
  deleteProjectGroup,
  moveProjectToGroup,
  reorderTopLevel,
  reorderProjectsInGroup
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
  // Thin IPC wrappers over the electron-free `@slayzone/projects/server` store —
  // the same fns the tRPC projectGroupsRouter calls (single source of truth,
  // coexisting until the bridge drops). Discord-style folders (rail) + labeled
  // collapsible sections (tree); mutating ops return an authoritative
  // { projects, groups } snapshot the renderer replaces state with.
  ipcMain.handle('db:project-groups:getAll', () => listProjectGroups(db))

  ipcMain.handle('db:project-groups:create', (_, data: CreateProjectGroupInput) =>
    createProjectGroup(db, data)
  )

  ipcMain.handle('db:project-groups:createWith', (_, projectIds: string[]) =>
    createFolderWithProjects(db, projectIds)
  )

  ipcMain.handle('db:project-groups:update', (_, data: UpdateProjectGroupInput) =>
    updateProjectGroup(db, data)
  )

  ipcMain.handle('db:project-groups:delete', (_, id: string) => deleteProjectGroup(db, id))

  ipcMain.handle(
    'db:project-groups:moveProject',
    (_, projectId: string, groupId: string | null, targetIndex: number) =>
      moveProjectToGroup(db, projectId, groupId, targetIndex)
  )

  ipcMain.handle('db:project-groups:reorderTopLevel', (_, entries: TopLevelEntryRef[]) =>
    reorderTopLevel(db, entries)
  )

  ipcMain.handle('db:project-groups:reorderWithin', (_, groupId: string, projectIds: string[]) =>
    reorderProjectsInGroup(db, groupId, projectIds)
  )
}
