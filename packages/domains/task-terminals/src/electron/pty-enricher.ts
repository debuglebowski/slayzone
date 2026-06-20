import type { SlayzoneDb } from '@slayzone/platform'
import type { PtyInfo } from '@slayzone/terminal/shared'

// The IPC tabs:* handlers (registerTerminalTabsHandlers) were removed at the
// IPC→tRPC cutover — the renderer uses the tRPC `taskTerminals` router over the
// same electron-free tab store. The host-side helpers below remain.

// Moved to the electron-free server entry (the REST API + standalone server
// need them); re-exported here so existing electron-entry importers keep working.
export { markTabSpawned, markTabHibernated } from '../server'

/** Returns an enricher for pty-manager's `listPtys()` that attaches `tabId` +
 *  `label` from `terminal_tabs`. Wire via `setPtyEnricher` at app boot — keeps
 *  pty-manager from touching the task-terminals schema directly. sessionId
 *  format: `${taskId}` for main pty, `${taskId}:${tabId}` for panes. */
export function createPtyEnricher(db: SlayzoneDb): (raw: PtyInfo[]) => Promise<PtyInfo[]> {
  return async (raw) => {
    if (raw.length === 0) return raw
    const taskIds = [...new Set(raw.map((r) => r.taskId))]
    const placeholders = taskIds.map(() => '?').join(',')
    const tabs = (await db
      .prepare(
        `SELECT id, task_id, label, is_main FROM terminal_tabs WHERE task_id IN (${placeholders})`
      )
      .all(...taskIds)) as Array<{
      id: string
      task_id: string
      label: string | null
      is_main: number
    }>
    const byPaneId = new Map<string, { id: string; label: string | null }>()
    const mainByTaskId = new Map<string, { id: string; label: string | null }>()
    for (const t of tabs) {
      byPaneId.set(t.id, { id: t.id, label: t.label })
      if (t.is_main) mainByTaskId.set(t.task_id, { id: t.id, label: t.label })
    }
    return raw.map((r) => {
      const colon = r.sessionId.indexOf(':')
      const tab =
        colon >= 0 ? byPaneId.get(r.sessionId.slice(colon + 1)) : mainByTaskId.get(r.taskId)
      return { ...r, tabId: tab?.id ?? '', label: tab?.label ?? null }
    })
  }
}
