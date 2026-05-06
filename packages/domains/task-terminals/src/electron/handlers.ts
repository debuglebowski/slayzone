import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { TerminalTab, CreateTerminalTabInput, UpdateTerminalTabInput } from '../shared/types'
import { createTabRow, splitTabRow, rowToTab, resolveDisplayMode, type TabRow } from '../server/ops'

export function registerTerminalTabsHandlers(ipcMain: IpcMain, db: Database): void {
  ipcMain.handle('tabs:list', (_, taskId: string): TerminalTab[] => {
    const rows = db.prepare(
      'SELECT * FROM terminal_tabs WHERE task_id = ? ORDER BY position ASC'
    ).all(taskId) as TabRow[]
    return rows.map(rowToTab)
  })

  ipcMain.handle('tabs:create', (_, input: CreateTerminalTabInput): TerminalTab => {
    return createTabRow(db, input)
  })

  ipcMain.handle('tabs:split', (_, tabId: string): TerminalTab | null => {
    return splitTabRow(db, tabId)
  })

  ipcMain.handle('tabs:moveToGroup', (_, tabId: string, targetGroupId: string | null): TerminalTab | null => {
    const tab = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(tabId) as TabRow | undefined
    if (!tab) return null
    const newGroupId = targetGroupId ?? tabId
    db.prepare('UPDATE terminal_tabs SET group_id = ? WHERE id = ?').run(newGroupId, tabId)
    tab.group_id = newGroupId
    return rowToTab(tab)
  })

  ipcMain.handle('tabs:update', (_, input: UpdateTerminalTabInput): TerminalTab | null => {
    const existing = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(input.id) as TabRow | undefined
    if (!existing) return null
    const mode = input.mode ?? existing.mode
    const displayMode = input.displayMode ?? (existing.display_mode === 'chat' ? 'chat' : 'xterm')
    const label = input.label !== undefined ? input.label : existing.label
    db.prepare(`
      UPDATE terminal_tabs
      SET label = ?, mode = ?, display_mode = ?, position = COALESCE(?, position)
      WHERE id = ?
    `).run(label, mode, displayMode, input.position, input.id)
    const updated = db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(input.id) as TabRow
    return rowToTab(updated)
  })

  ipcMain.handle('tabs:delete', (_, tabId: string): boolean => {
    const tab = db.prepare('SELECT is_main FROM terminal_tabs WHERE id = ?').get(tabId) as { is_main: number } | undefined
    if (!tab) return false
    if (tab.is_main === 1) return false
    db.prepare('DELETE FROM terminal_tabs WHERE id = ?').run(tabId)
    return true
  })

  ipcMain.handle('tabs:ensureMain', (_, taskId: string, mode: string): TerminalTab => {
    const existing = db.prepare(
      'SELECT * FROM terminal_tabs WHERE task_id = ? AND is_main = 1'
    ).get(taskId) as TabRow | undefined

    if (existing) {
      if (existing.mode !== mode) {
        db.prepare('UPDATE terminal_tabs SET mode = ? WHERE id = ?').run(mode, existing.id)
        existing.mode = mode
      }
      if (!existing.group_id) {
        db.prepare('UPDATE terminal_tabs SET group_id = ? WHERE id = ?').run(existing.id, existing.id)
        existing.group_id = existing.id
      }
      return rowToTab(existing)
    }

    const displayMode = resolveDisplayMode(db, mode)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO terminal_tabs (id, task_id, label, mode, display_mode, is_main, position, group_id, created_at)
      VALUES (?, ?, NULL, ?, ?, 1, 0, ?, ?)
    `).run(taskId, taskId, mode, displayMode, taskId, now)

    return {
      id: taskId, taskId, groupId: taskId, label: null,
      mode: mode as TerminalTab['mode'], displayMode, isMain: true,
      position: 0, createdAt: now
    }
  })
}
