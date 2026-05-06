import type { Database } from 'better-sqlite3'
import { supportsChatMode } from '@slayzone/terminal/server'
import type { TabDisplayMode, TerminalTab, CreateTerminalTabInput, UpdateTerminalTabInput } from '../shared/types'

export function resolveDisplayMode(db: Database, mode: string): TabDisplayMode {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get('default_tab_display_mode') as { value: string } | undefined
  return row?.value === 'chat' && supportsChatMode(mode) ? 'chat' : 'xterm'
}

export interface TabRow {
  id: string
  task_id: string
  group_id: string | null
  label: string | null
  mode: string
  display_mode: string | null
  is_main: number
  position: number
  created_at: string
}

export function rowToTab(row: TabRow): TerminalTab {
  return {
    id: row.id,
    taskId: row.task_id,
    groupId: row.group_id || row.id,
    label: row.label,
    mode: row.mode as TerminalTab['mode'],
    displayMode: (row.display_mode === 'chat' ? 'chat' : 'xterm') as TabDisplayMode,
    isMain: row.is_main === 1,
    position: row.position,
    createdAt: row.created_at
  }
}

/** Pure DB write — insert a new tab (new group). Used by IPC handler + REST route. */
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
    createdAt: now
  }
}

/** Pure DB write — insert a new pane in the same group as the target tab. */
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
    createdAt: now
  }
}

export type { CreateTerminalTabInput, UpdateTerminalTabInput, TerminalTab }
