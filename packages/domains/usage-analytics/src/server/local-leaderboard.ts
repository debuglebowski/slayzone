import type { SlayzoneDb } from '@slayzone/platform'
import type { LocalLeaderboardStats } from '../shared'
import { refreshUsageData, queryDailyTotals, type UsageScope } from './cache'
import { isCompletedStatus, parseColumnsConfig } from '@slayzone/projects-contracts'

async function getDailyTokens(
  db: SlayzoneDb,
  scope: UsageScope
): Promise<Array<{ date: string; totalTokens: number }>> {
  try {
    await refreshUsageData(db)
  } catch {
    /* best-effort: still query stale data */
  }
  return queryDailyTotals(db, scope)
}

async function getTodayCompletedTasks(db: SlayzoneDb, scope: UsageScope): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const ids = scope?.projectIds ?? []
  const inScope = !scope
    ? ''
    : ids.length === 0
      ? ' AND 0'
      : ` AND p.id IN (${ids.map(() => '?').join(', ')})`
  const rows = (await db.all(
    `SELECT t.status, p.columns_config
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.is_temporary = 0
       AND t.archived_at IS NULL
       AND date(t.updated_at) = ?${inScope}`,
    [today, ...(scope ? ids : [])]
  )) as Array<{ status: string; columns_config: string | null }>

  return rows.reduce(
    (count, row) =>
      isCompletedStatus(row.status, parseColumnsConfig(row.columns_config)) ? count + 1 : count,
    0
  )
}

/**
 * Local leaderboard stats, computed where the data is.
 *
 * Lived in `apps/app/src/main` and was reached through the `leaderboardGetLocalStats`
 * AppDeps slot — i.e. the hub asked the desktop to run a query against a database the
 * hub itself owns. Nothing here touches Electron; it was on the host only because the
 * `db` handle was. A standalone hub consequently had no leaderboard at all (the slot
 * was a fail-loud stub), which this move fixes as a side effect.
 */
export async function getLocalLeaderboardStats(
  db: SlayzoneDb,
  scope: UsageScope = null
): Promise<LocalLeaderboardStats> {
  const today = new Date().toISOString().slice(0, 10)
  const todayCompletedTasks = await getTodayCompletedTasks(db, scope)
  const tokenDays = await getDailyTokens(db, scope)

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
}
