import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { supportsChatMode } from '@slayzone/terminal/main'
import type { PtyInfo } from '@slayzone/terminal/shared'
import type { TabDisplayMode, TerminalTab, CreateTerminalTabInput, UpdateTerminalTabInput } from '../shared/types'

function resolveDisplayMode(db: Database, mode: string): TabDisplayMode {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get('default_tab_display_mode') as { value: string } | undefined
  return row?.value === 'chat' && supportsChatMode(mode) ? 'chat' : 'xterm'
}

interface TabRow {
  id: string
  task_id: string
  group_id: string | null
  label: string | null
  mode: string
  display_mode: string | null
  is_main: number
  position: number
  created_at: string
  was_spawned: number
}

function rowToTab(row: TabRow): TerminalTab {
  return {
    id: row.id,
    taskId: row.task_id,
    groupId: row.group_id || row.id,
    label: row.label,
    mode: row.mode as TerminalTab['mode'],
    displayMode: (row.display_mode === 'chat' ? 'chat' : 'xterm') as TabDisplayMode,
    isMain: row.is_main === 1,
    position: row.position,
    createdAt: row.created_at,
    wasSpawned: row.was_spawned === 1
  }
}

/**
 * Mark a tab's subprocess liveness in DB. Called by pty-manager + chat-transport
 * around spawn/exit so reboots can restore warm agents. Direct DB write — kept
 * lean since hot-path called from spawn/exit handlers.
 *
 * Resolution rules for the tabId arg:
 *   - PTY main session: pty sessionId is `${taskId}` → main tab row has `id = task_id` (see tabs:ensureMain insert)
 *   - PTY pane: sessionId is `${taskId}:${tabId}` → tabId is the row id directly
 *   - Chat: tabId is the row id directly
 * Caller resolves the row id and passes it here; we just UPDATE by id.
 */
export function markTabSpawned(db: Database, tabId: string, wasSpawned: boolean): void {
  db.prepare('UPDATE terminal_tabs SET was_spawned = ? WHERE id = ?').run(wasSpawned ? 1 : 0, tabId)
}

/** Pure DB write — insert a new tab (new group). Used by both IPC handler
 *  (`tabs:create`) and REST route (`POST /api/tabs/create`). Caller is
 *  responsible for any IPC broadcast. */
export function createTabRow(db: Database, input: CreateTerminalTabInput): TerminalTab {
  const id = crypto.randomUUID()
  const mode = input.mode || 'terminal'

  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) as max_pos FROM terminal_tabs WHERE task_id = ?'
  ).get(input.taskId) as { max_pos: number }
  const position = maxPos.max_pos + 1

  const label = input.label ?? null
  const displayMode = resolveDisplayMode(db, mode)

  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO terminal_tabs (id, task_id, label, mode, display_mode, is_main, position, group_id, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(id, input.taskId, label, mode, displayMode, position, id, now)

  return {
    id,
    taskId: input.taskId,
    groupId: id,
    label,
    mode: mode as TerminalTab['mode'],
    displayMode,
    isMain: false,
    position,
    createdAt: now,
    wasSpawned: false
  }
}

/** Returns an enricher for pty-manager's `listPtys()` that attaches `tabId` +
 *  `label` from `terminal_tabs`. Wire via `setPtyEnricher` at app boot — keeps
 *  pty-manager from touching the task-terminals schema directly. sessionId
 *  format: `${taskId}` for main pty, `${taskId}:${tabId}` for panes. */
export function createPtyEnricher(db: Database): (raw: PtyInfo[]) => PtyInfo[] {
  return (raw) => {
    if (raw.length === 0) return raw
    const taskIds = [...new Set(raw.map(r => r.taskId))]
    const placeholders = taskIds.map(() => '?').join(',')
    const tabs = db.prepare(
      `SELECT id, task_id, label, is_main FROM terminal_tabs WHERE task_id IN (${placeholders})`
    ).all(...taskIds) as Array<{ id: string; task_id: string; label: string | null; is_main: number }>
    const byPaneId = new Map<string, { id: string; label: string | null }>()
    const mainByTaskId = new Map<string, { id: string; label: string | null }>()
    for (const t of tabs) {
      byPaneId.set(t.id, { id: t.id, label: t.label })
      if (t.is_main) mainByTaskId.set(t.task_id, { id: t.id, label: t.label })
    }
    return raw.map(r => {
      const colon = r.sessionId.indexOf(':')
      const tab = colon >= 0
        ? byPaneId.get(r.sessionId.slice(colon + 1))
        : mainByTaskId.get(r.taskId)
      return { ...r, tabId: tab?.id ?? '', label: tab?.label ?? null }
    })
  }
}

/** Pure DB write — update a tab. Returns null if not found.
 *  Used by both IPC handler (`tabs:update`) and REST route. */
export function updateTabRow(db: Database, input: UpdateTerminalTabInput): TerminalTab | null {
  const existing = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(input.id) as TabRow | undefined
  if (!existing) return null

  const mode = input.mode ?? existing.mode
  const displayMode = input.displayMode ?? (existing.display_mode === 'chat' ? 'chat' : 'xterm')
  const label = input.label !== undefined ? input.label : existing.label

  db.prepare(`
    UPDATE terminal_tabs
    SET label = ?,
        mode = ?,
        display_mode = ?,
        position = COALESCE(?, position)
    WHERE id = ?
  `).run(label, mode, displayMode, input.position, input.id)

  const updated = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(input.id) as TabRow
  return rowToTab(updated)
}

/** Pure DB write — insert a new pane in the same group as the target tab.
 *  Returns null if target not found. Used by both IPC handler (`tabs:split`)
 *  and REST route (`POST /api/tabs/split`). */
export function splitTabRow(db: Database, tabId: string): TerminalTab | null {
  const target = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(tabId) as TabRow | undefined
  if (!target) return null

  const groupId = target.group_id || target.id
  const id = crypto.randomUUID()

  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) as max_pos FROM terminal_tabs WHERE task_id = ? AND group_id = ?'
  ).get(target.task_id, groupId) as { max_pos: number }
  const position = maxPos.max_pos + 1

  const displayMode = resolveDisplayMode(db, 'terminal')
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO terminal_tabs (id, task_id, label, mode, display_mode, is_main, position, group_id, created_at)
    VALUES (?, ?, NULL, 'terminal', ?, 0, ?, ?, ?)
  `).run(id, target.task_id, displayMode, position, groupId, now)

  return {
    id,
    taskId: target.task_id,
    groupId,
    label: null,
    mode: 'terminal',
    displayMode,
    isMain: false,
    position,
    createdAt: now,
    wasSpawned: false
  }
}

export function registerTerminalTabsHandlers(ipcMain: IpcMain, db: Database): void {
  // List tabs for a task
  ipcMain.handle('tabs:list', (_, taskId: string): TerminalTab[] => {
    const rows = db.prepare(
      'SELECT * FROM terminal_tabs WHERE task_id = ? ORDER BY position ASC'
    ).all(taskId) as TabRow[]

    return rows.map(rowToTab)
  })

  // Create a new tab (new group)
  ipcMain.handle('tabs:create', (_, input: CreateTerminalTabInput): TerminalTab => {
    return createTabRow(db, input)
  })

  // Split: create a new pane in the same group as the target tab
  ipcMain.handle('tabs:split', (_, tabId: string): TerminalTab | null => {
    return splitTabRow(db, tabId)
  })

  // Move a tab to a different group (or create a new group if targetGroupId is null)
  ipcMain.handle('tabs:moveToGroup', (_, tabId: string, targetGroupId: string | null): TerminalTab | null => {
    const tab = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(tabId) as TabRow | undefined
    if (!tab) return null

    const newGroupId = targetGroupId ?? tabId // null = become own group
    db.prepare('UPDATE terminal_tabs SET group_id = ? WHERE id = ?').run(newGroupId, tabId)
    tab.group_id = newGroupId
    return rowToTab(tab)
  })

  // Update a tab
  ipcMain.handle('tabs:update', (_, input: UpdateTerminalTabInput): TerminalTab | null => {
    return updateTabRow(db, input)
  })

  // Delete a tab (reject if main)
  ipcMain.handle('tabs:delete', (_, tabId: string): boolean => {
    const tab = db.prepare('SELECT is_main, task_id FROM terminal_tabs WHERE id = ?').get(tabId) as { is_main: number; task_id: string } | undefined
    if (!tab) return false
    if (tab.is_main === 1) return false // Can't delete main tab

    db.prepare('DELETE FROM terminal_tabs WHERE id = ?').run(tabId)
    return true
  })

  // Ensure main tab exists for a task (creates if missing)
  ipcMain.handle('tabs:ensureMain', (_, taskId: string, mode: string): TerminalTab => {
    const existing = db.prepare(
      'SELECT * FROM terminal_tabs WHERE task_id = ? AND is_main = 1'
    ).get(taskId) as TabRow | undefined

    if (existing) {
      // Update mode if it changed (e.g. user switched terminal mode on task)
      if (existing.mode !== mode) {
        db.prepare('UPDATE terminal_tabs SET mode = ? WHERE id = ?').run(mode, existing.id)
        existing.mode = mode
      }
      // Backfill group_id if missing (pre-v39 rows)
      if (!existing.group_id) {
        db.prepare('UPDATE terminal_tabs SET group_id = ? WHERE id = ?').run(existing.id, existing.id)
        existing.group_id = existing.id
      }
      return rowToTab(existing)
    }

    // Create main tab - use taskId as id (unique since one main per task)
    const displayMode = resolveDisplayMode(db, mode)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO terminal_tabs (id, task_id, label, mode, display_mode, is_main, position, group_id, created_at)
      VALUES (?, ?, NULL, ?, ?, 1, 0, ?, ?)
    `).run(taskId, taskId, mode, displayMode, taskId, now)

    return {
      id: taskId,
      taskId,
      groupId: taskId,
      label: null,
      mode: mode as TerminalTab['mode'],
      displayMode,
      isMain: true,
      position: 0,
      createdAt: now,
      wasSpawned: false
    }
  })
}
