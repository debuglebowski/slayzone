import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type { DateRange } from '../shared/types'
import { refreshUsageData, queryAnalytics, queryTaskCost } from './cache'

export function registerUsageAnalyticsHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
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
