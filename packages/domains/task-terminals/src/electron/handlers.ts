import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtyInfo } from '@slayzone/terminal/shared'
import type { CreateTerminalTabInput, UpdateTerminalTabInput } from '../shared/types'
import {
  listTabsForTask,
  ensureMainTab,
  createTabRow,
  updateTabRow,
  splitTabRow,
  moveTabToGroup,
  deleteTab,
  listHibernatedSessionIds
} from '../server'

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

/**
 * Thin IPC wrappers over the electron-free tab store (`../server`). Both these
 * `tabs:*` handlers and the tRPC `taskTerminals` router call the same store, so
 * they share one implementation while IPC + tRPC coexist (renderer cutover +
 * handler deletion land in a later slice).
 */
export function registerTerminalTabsHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  // List tabs for a task
  ipcMain.handle('tabs:list', (_, taskId: string) => listTabsForTask(db, taskId))

  // Main-tab session ids flagged hibernated — seeds PtyContext's 💤 dots at boot.
  ipcMain.handle('tabs:listHibernatedSessions', () => listHibernatedSessionIds(db))

  // Create a new tab (new group)
  ipcMain.handle('tabs:create', (_, input: CreateTerminalTabInput) => createTabRow(db, input))

  // Split: create a new pane in the same group as the target tab
  ipcMain.handle('tabs:split', (_, tabId: string) => splitTabRow(db, tabId))

  // Move a tab to a different group (or create a new group if targetGroupId is null)
  ipcMain.handle('tabs:moveToGroup', (_, tabId: string, targetGroupId: string | null) =>
    moveTabToGroup(db, tabId, targetGroupId)
  )

  // Update a tab
  ipcMain.handle('tabs:update', (_, input: UpdateTerminalTabInput) => updateTabRow(db, input))

  // Delete a tab (reject if main)
  ipcMain.handle('tabs:delete', (_, tabId: string) => deleteTab(db, tabId))

  // Ensure main tab exists for a task (creates if missing)
  ipcMain.handle('tabs:ensureMain', (_, taskId: string, mode: string) =>
    ensureMainTab(db, taskId, mode)
  )
}
