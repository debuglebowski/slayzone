import type { IpcMain } from 'electron'
import type Database from 'better-sqlite3'
import type { DateRange } from '../shared/types'
import { refreshUsageData, queryAnalytics, queryTaskCost } from '../server/cache'

export function registerUsageAnalyticsHandlers(ipcMain: IpcMain, db: Database.Database): void {
  ipcMain.handle('usage-analytics:query', async (_, range: DateRange) => {
    return queryAnalytics(db, range)
  })

  ipcMain.handle('usage-analytics:refresh', async (_, range: DateRange) => {
    try {
      await refreshUsageData(db)
    } catch (err) {
      console.error('[usage-analytics] refresh failed:', err)
    }
    return queryAnalytics(db, range)
  })

  ipcMain.handle('usage-analytics:task-cost', async (_, taskId: string) => {
    return queryTaskCost(db, taskId)
  })
}
