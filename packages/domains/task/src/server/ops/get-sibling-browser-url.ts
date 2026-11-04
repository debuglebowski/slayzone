import type { SlayzoneDb } from '@slayzone/platform'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import { firstRealBrowserUrl } from '../../shared/browser-tabs.js'
import { safeJsonParse, TASK_ORDER_BY } from './shared.js'

/**
 * The fallback browser URL for a task with no tabs of its own: the first real
 * URL among the OTHER live tasks of the same project, in board order. Browser
 * state never crosses projects.
 *
 * This used to be computed on the client from `task.getByProject` — every task
 * in the project, fully parsed and serialized, once per opened task tab (≈1.5 MB
 * per tab for a 500-task project, all restored tabs at once on boot) to find one
 * string. Only rows that HAVE browser state are read here.
 */
export async function getSiblingBrowserUrlOp(
  db: SlayzoneDb,
  projectId: string,
  excludeTaskId: string
): Promise<{ url: string | null }> {
  const rows = await db.all<{ browser_tabs: string }>(
    `SELECT t.browser_tabs FROM tasks t
      WHERE t.project_id = ? AND t.id <> ? AND t.browser_tabs IS NOT NULL
        AND t.archived_at IS NULL AND t.deleted_at IS NULL
      ${TASK_ORDER_BY}`,
    [projectId, excludeTaskId]
  )
  for (const row of rows) {
    const url = firstRealBrowserUrl(safeJsonParse(row.browser_tabs) as BrowserTabsState | null)
    if (url) return { url }
  }
  return { url: null }
}
