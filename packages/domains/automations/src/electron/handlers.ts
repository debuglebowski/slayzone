import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type { CreateAutomationInput, UpdateAutomationInput } from '@slayzone/automations/shared'
import {
  listAutomationsByProject,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  toggleAutomation,
  reorderAutomations,
  listAutomationRuns,
  clearAutomationRuns
} from '@slayzone/automations/server'
import type { AutomationEngine } from './engine'

/**
 * IPC surface for the automations domain. The DB ops live in the shared
 * electron-free store (`@slayzone/automations/server`) so these handlers and
 * the tRPC `automationsRouter` call one implementation while IPC + tRPC
 * coexist (renderer cutover is a later slice). `runManual` stays here because
 * it drives the engine, not the DB.
 */
export function registerAutomationHandlers(
  ipcMain: IpcMain,
  db: SlayzoneDb,
  engine: AutomationEngine
): void {
  ipcMain.handle('db:automations:getByProject', (_, projectId: string) =>
    listAutomationsByProject(db, projectId)
  )

  ipcMain.handle('db:automations:get', (_, id: string) => getAutomation(db, id))

  ipcMain.handle('db:automations:create', (_, data: CreateAutomationInput) =>
    createAutomation(db, data)
  )

  ipcMain.handle('db:automations:update', (_, data: UpdateAutomationInput) =>
    updateAutomation(db, data)
  )

  ipcMain.handle('db:automations:delete', (_, id: string) => deleteAutomation(db, id))

  ipcMain.handle('db:automations:toggle', (_, id: string, enabled: boolean) =>
    toggleAutomation(db, id, enabled)
  )

  ipcMain.handle('db:automations:reorder', (_, ids: string[]) => reorderAutomations(db, ids))

  ipcMain.handle('db:automations:getRuns', (_, automationId: string, limit?: number) =>
    listAutomationRuns(db, automationId, limit)
  )

  ipcMain.handle('db:automations:runManual', (_, id: string) => engine.executeManual(id))

  ipcMain.handle('db:automations:clearRuns', (_, automationId: string) =>
    clearAutomationRuns(db, automationId)
  )
}
