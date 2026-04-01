import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { listActivityEventsForTask, listAutomationActionRuns } from './recorder'
import type { ListTaskHistoryOptions } from '../shared/types'

export function registerHistoryHandlers(ipcMain: IpcMain, db: Database): void {
  ipcMain.handle('history:listForTask', (_event, taskId: string, options?: ListTaskHistoryOptions) => {
    return listActivityEventsForTask(db, taskId, options)
  })

  ipcMain.handle('history:getAutomationActionRuns', (_event, runId: string) => {
    return listAutomationActionRuns(db, runId)
  })
}
