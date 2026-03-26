import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { LocalLeaderboardStats } from '@slayzone/types'
import { refreshUsageData, queryDailyTotals } from '@slayzone/usage-analytics/main'
import { isCompletedStatus, parseColumnsConfig } from '@slayzone/projects/shared'

async function getDailyTokens(db: Database): Promise<Array<{ date: string; totalTokens: number }>> {
  try { await refreshUsageData(db) } catch { /* best-effort: still query stale data */ }
  return queryDailyTotals(db)
}

function getTodayCompletedTasks(db: Database): number {
  const today = new Date().toISOString().slice(0, 10)
  const rows = db
    .prepare(
      `SELECT t.status, p.columns_config
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.is_temporary = 0
       AND t.archived_at IS NULL
       AND date(t.updated_at) = ?`
    )
    .all(today) as Array<{ status: string; columns_config: string | null }>

  return rows.reduce((count, row) => (
    isCompletedStatus(row.status, parseColumnsConfig(row.columns_config)) ? count + 1 : count
  ), 0)
}

export function registerLeaderboardHandlers(ipcMain: IpcMain, db: Database): void {
  ipcMain.handle('leaderboard:get-local-stats', async (): Promise<LocalLeaderboardStats> => {
    const today = new Date().toISOString().slice(0, 10)
    const todayCompletedTasks = getTodayCompletedTasks(db)
    const tokenDays = await getDailyTokens(db)

    const days = tokenDays
      .map((d) => ({
        date: d.date,
        totalTokens: d.totalTokens,
        totalCompletedTasks: d.date === today ? todayCompletedTasks : 0
      }))
      .filter((d) => d.date === today || d.totalTokens > 0)

    if (!days.find((d) => d.date === today)) {
      days.push({ date: today, totalTokens: 0, totalCompletedTasks: todayCompletedTasks })
    }

    return { days }
  })
}
