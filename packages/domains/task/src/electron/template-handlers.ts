import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type { CreateTaskTemplateInput, UpdateTaskTemplateInput } from '@slayzone/task/shared'
import {
  listTemplatesByProject,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  setDefaultTemplate
} from '../server/template-store'

// Logic lives in the electron-free ../server/template-store (shared with the tRPC
// `template` router). These IPC handlers stay registered for renderer coexistence
// until the cutover (slice 5). Re-export for existing importers (ops/create.ts).
export { getTemplateForTask, parseTemplate } from '../server/template-store'

export function registerTaskTemplateHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  ipcMain.handle('db:taskTemplates:getByProject', (_, projectId: string) =>
    listTemplatesByProject(db, projectId)
  )
  ipcMain.handle('db:taskTemplates:get', (_, id: string) => getTemplate(db, id))
  ipcMain.handle('db:taskTemplates:create', (_, data: CreateTaskTemplateInput) =>
    createTemplate(db, data)
  )
  ipcMain.handle('db:taskTemplates:update', (_, data: UpdateTaskTemplateInput) =>
    updateTemplate(db, data)
  )
  ipcMain.handle('db:taskTemplates:delete', (_, id: string) => deleteTemplate(db, id))
  ipcMain.handle(
    'db:taskTemplates:setDefault',
    (_, projectId: string, templateId: string | null) =>
      setDefaultTemplate(db, projectId, templateId)
  )
}
