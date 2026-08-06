import type { SlayzoneDb } from '@slayzone/platform'
import type { PtyInfo } from '@slayzone/terminal/shared'

// The IPC tabs:* handlers (registerTerminalTabsHandlers) were removed at the
// IPC→tRPC cutover — the renderer uses the tRPC `taskTerminals` router over the
// same electron-free tab store. The host-side helpers below remain.

// Moved to the electron-free server entry (the REST API + standalone server
// need them); re-exported here so existing electron-entry importers keep working.
export { markTabSpawned, markTabHibernated } from '../server'

/** Returns an enricher for pty-manager's `listPtys()` that attaches the tab
 *  `label` from `terminal_tabs`. Wire via `setPtyEnricher` at app boot — keeps
 *  pty-manager from touching the task-terminals schema directly. `tabId` is now
 *  resolved by pty-manager's identity seam (opaque-id safe); this enricher only
 *  joins the human label for it. */
export function createPtyEnricher(db: SlayzoneDb): (raw: PtyInfo[]) => Promise<PtyInfo[]> {
  return async (raw) => {
    if (raw.length === 0) return raw
    const taskIds = [...new Set(raw.map((r) => r.taskId))]
    const placeholders = taskIds.map(() => '?').join(',')
    const tabs = (await db
      .prepare(`SELECT id, label FROM terminal_tabs WHERE task_id IN (${placeholders})`)
      .all(...taskIds)) as Array<{ id: string; label: string | null }>
    const labelByTabId = new Map(tabs.map((t) => [t.id, t.label]))
    return raw.map((r) => ({ ...r, label: labelByTabId.get(r.tabId) ?? null }))
  }
}
