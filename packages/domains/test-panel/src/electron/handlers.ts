import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  scanTestFiles,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  listProfiles,
  saveProfile,
  deleteProfile,
  applyProfile,
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  listFileLabels,
  listFileNotes,
  setFileNote,
  toggleFileLabel
} from '../server'
import type {
  CreateTestCategoryInput,
  UpdateTestCategoryInput,
  TestProfile,
  CreateTestLabelInput,
  UpdateTestLabelInput
} from '../shared/types'

// Thin IPC wrappers over the electron-free store (../server). Both these
// `db:testPanel:*` handlers and the tRPC testPanelRouter call the same store so
// they share one implementation while IPC + tRPC coexist (renderer cutover +
// handler deletion land in a later slice).
export function registerTestPanelHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  // Categories CRUD
  ipcMain.handle('db:testPanel:getCategories', (_, projectId: string) =>
    listCategories(db, projectId)
  )
  ipcMain.handle('db:testPanel:createCategory', (_, data: CreateTestCategoryInput) =>
    createCategory(db, data)
  )
  ipcMain.handle('db:testPanel:updateCategory', (_, data: UpdateTestCategoryInput) =>
    updateCategory(db, data)
  )
  ipcMain.handle('db:testPanel:deleteCategory', (_, id: string) => deleteCategory(db, id))
  ipcMain.handle('db:testPanel:reorderCategories', (_, ids: string[]) => reorderCategories(db, ids))

  // Profiles (stored in settings key-value table)
  ipcMain.handle('db:testPanel:getProfiles', () => listProfiles(db))
  ipcMain.handle('db:testPanel:saveProfile', (_, profile: TestProfile) => saveProfile(db, profile))
  ipcMain.handle('db:testPanel:deleteProfile', (_, id: string) => deleteProfile(db, id))
  ipcMain.handle('db:testPanel:applyProfile', (_, projectId: string, profileId: string) =>
    applyProfile(db, projectId, profileId)
  )

  // File scanning
  ipcMain.handle('db:testPanel:scanFiles', async (_, projectPath: string, projectId: string) => {
    const categories = await listCategories(db, projectId)
    return scanTestFiles(projectPath, categories)
  })

  // Labels CRUD
  ipcMain.handle('db:testPanel:getLabels', (_, projectId: string) => listLabels(db, projectId))
  ipcMain.handle('db:testPanel:createLabel', (_, data: CreateTestLabelInput) => createLabel(db, data))
  ipcMain.handle('db:testPanel:updateLabel', (_, data: UpdateTestLabelInput) => updateLabel(db, data))
  ipcMain.handle('db:testPanel:deleteLabel', (_, id: string) => deleteLabel(db, id))

  // File label assignments
  ipcMain.handle('db:testPanel:getFileLabels', (_, projectId: string) =>
    listFileLabels(db, projectId)
  )

  // File notes
  ipcMain.handle('db:testPanel:getFileNotes', (_, projectId: string) => listFileNotes(db, projectId))
  ipcMain.handle(
    'db:testPanel:setFileNote',
    (_, projectId: string, filePath: string, note: string) =>
      setFileNote(db, projectId, filePath, note)
  )
  ipcMain.handle(
    'db:testPanel:toggleFileLabel',
    (_, projectId: string, filePath: string, labelId: string) =>
      toggleFileLabel(db, projectId, filePath, labelId)
  )
}
