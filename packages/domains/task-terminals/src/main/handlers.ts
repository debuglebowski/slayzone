import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { TerminalTab, CreateTerminalTabInput, UpdateTerminalTabInput } from '../shared/types'

interface TabRow {
  id: string
  task_id: string
  group_id: string | null
  label: string | null
  mode: string
  is_main: number
  position: number
  created_at: string
}

function rowToTab(row: TabRow): TerminalTab {
  return {
    id: row.id,
    taskId: row.task_id,
    groupId: row.group_id || row.id,
    label: row.label,
    mode: row.mode as TerminalTab['mode'],
    isMain: row.is_main === 1,
    position: row.position,
    createdAt: row.created_at
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
    const id = crypto.randomUUID()
    const mode = input.mode || 'terminal'

    // Get next position
    const maxPos = db.prepare(
      'SELECT COALESCE(MAX(position), -1) as max_pos FROM terminal_tabs WHERE task_id = ?'
    ).get(input.taskId) as { max_pos: number }
    const position = maxPos.max_pos + 1

    const label = input.label ?? null

    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, input.taskId, label, mode, position, id, now)

    return {
      id,
      taskId: input.taskId,
      groupId: id,
      label,
      mode: mode as TerminalTab['mode'],
      isMain: false,
      position,
      createdAt: now
    }
  })

  // Split: create a new pane in the same group as the target tab
  ipcMain.handle('tabs:split', (_, tabId: string): TerminalTab | null => {
    const target = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(tabId) as TabRow | undefined
    if (!target) return null

    const groupId = target.group_id || target.id
    const id = crypto.randomUUID()

    // Get next position within group
    const maxPos = db.prepare(
      'SELECT COALESCE(MAX(position), -1) as max_pos FROM terminal_tabs WHERE task_id = ? AND group_id = ?'
    ).get(target.task_id, groupId) as { max_pos: number }
    const position = maxPos.max_pos + 1

    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
      VALUES (?, ?, NULL, 'terminal', 0, ?, ?, ?)
    `).run(id, target.task_id, position, groupId, now)

    return {
      id,
      taskId: target.task_id,
      groupId,
      label: null,
      mode: 'terminal',
      isMain: false,
      position,
      createdAt: now
    }
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
    const existing = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(input.id) as TabRow | undefined
    if (!existing) return null

    const mode = input.mode ?? existing.mode

    const label = input.label !== undefined ? input.label : existing.label
    db.prepare(`
      UPDATE terminal_tabs
      SET label = ?,
          mode = ?,
          position = COALESCE(?, position)
      WHERE id = ?
    `).run(
      label,
      mode,
      input.position,
      input.id
    )

    const updated = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(input.id) as TabRow
    return rowToTab(updated)
  })

  // Delete a tab (reject if main)
  ipcMain.handle('tabs:delete', (_, tabId: string): boolean => {
    const tab = db.prepare('SELECT is_main FROM terminal_tabs WHERE id = ?').get(tabId) as { is_main: number } | undefined
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
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
      VALUES (?, ?, NULL, ?, 1, 0, ?, ?)
    `).run(taskId, taskId, mode, taskId, now)

    return {
      id: taskId,
      taskId,
      groupId: taskId,
      label: null,
      mode: mode as TerminalTab['mode'],
      isMain: true,
      position: 0,
      createdAt: now
    }
  })
}
