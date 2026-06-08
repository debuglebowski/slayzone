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
  deleteTab
} from '../server'

/**
 * Mark a tab's subprocess liveness in DB. Called by pty-manager + chat-transport
 * around spawn/exit so reboots can restore warm agents. Direct DB write — kept
 * lean since hot-path called from spawn/exit handlers.
 *
 * Resolution rules for the tabId arg:
 *   - PTY main session: sessionId is `${taskId}:${taskId}` → main tab row has `id = task_id` (see ensureMainTab insert)
 *   - PTY pane: sessionId is `${taskId}:${tabId}` → tabId is the row id directly
 *   - Chat: tabId is the row id directly
 * Caller resolves the row id and passes it here; we just UPDATE by id.
 */
export async function markTabSpawned(
  db: SlayzoneDb,
  tabId: string,
  wasSpawned: boolean
): Promise<void> {
  await db
    .prepare('UPDATE terminal_tabs SET was_spawned = ? WHERE id = ?')
    .run(wasSpawned ? 1 : 0, tabId)
}

/**
 * Persist a tab's idle-close (hibernation) status so the "sleeping 💤 / Reopen"
 * affordance survives reload + restart. Set true when the idle agent is killed,
 * false on any (re)spawn. Same tabId resolution as `markTabSpawned`.
 */
export async function markTabHibernated(
  db: SlayzoneDb,
  tabId: string,
  hibernated: boolean
): Promise<void> {
  await db
    .prepare('UPDATE terminal_tabs SET hibernated = ? WHERE id = ?')
    .run(hibernated ? 1 : 0, tabId)
}

/** Main-tab session ids (`${taskId}:${taskId}`) for tabs currently flagged
 *  hibernated. Seeds the renderer's PtyContext at boot so the 💤 dot shows for
 *  stale agents before any live session exists. */
export async function listHibernatedSessionIds(db: SlayzoneDb): Promise<string[]> {
  const rows = (await db
    .prepare('SELECT task_id FROM terminal_tabs WHERE hibernated = 1 AND is_main = 1')
    .all()) as Array<{ task_id: string }>
  return rows.map((r) => `${r.task_id}:${r.task_id}`)
}

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
 * handler deletion land in a later slice). `tabs:listHibernatedSessions` stays
 * local — it's PTY-hibernation seeding, not tab CRUD.
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
