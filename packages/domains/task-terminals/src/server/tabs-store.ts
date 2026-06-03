import type { SlayzoneDb } from '@slayzone/platform'
import type { TerminalTab, CreateTerminalTabInput, UpdateTerminalTabInput } from '../shared/types'

/**
 * Electron-free tab CRUD store. Single source of truth shared by the
 * `tabs:*` IPC handlers (task-terminals/main), the `/api/tabs/*` REST routes,
 * and the `taskTerminals` tRPC router — so IPC + tRPC coexist over one impl
 * while the renderer cutover (slice 5) is pending. No `electron` import here.
 */

export interface TabRow {
  id: string
  task_id: string
  group_id: string | null
  label: string | null
  mode: string
  is_main: number
  position: number
  created_at: string
  was_spawned: number
  hibernated: number
}

export function rowToTab(row: TabRow): TerminalTab {
  return {
    id: row.id,
    taskId: row.task_id,
    groupId: row.group_id || row.id,
    label: row.label,
    mode: row.mode as TerminalTab['mode'],
    isMain: row.is_main === 1,
    position: row.position,
    createdAt: row.created_at,
    wasSpawned: row.was_spawned === 1,
    hibernated: row.hibernated === 1
  }
}

/** List a task's tabs ordered by position. Used by `tabs:list` IPC handler +
 *  the `taskTerminals.list` tRPC query. */
export async function listTabsForTask(db: SlayzoneDb, taskId: string): Promise<TerminalTab[]> {
  const rows = (await db
    .prepare('SELECT * FROM terminal_tabs WHERE task_id = ? ORDER BY position ASC')
    .all(taskId)) as TabRow[]

  return rows.map(rowToTab)
}

/**
 * Idempotent main-tab insert/update. Shared between the `tabs:ensureMain` IPC
 * handler (renderer mount) and the REST `startMainPty` helper (CLI cold-start)
 * so both code paths produce identical rows. Returns the canonical TerminalTab.
 *
 * Main-tab convention: row `id = task_id`, group_id = task_id, is_main = 1.
 * Used in conjunction with the renderer's `getMainSessionId(t) => ${t}:${t}`.
 */
export async function ensureMainTab(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<TerminalTab> {
  const existing = (await db
    .prepare('SELECT * FROM terminal_tabs WHERE task_id = ? AND is_main = 1')
    .get(taskId)) as TabRow | undefined

  if (existing) {
    if (existing.mode !== mode) {
      await db.prepare('UPDATE terminal_tabs SET mode = ? WHERE id = ?').run(mode, existing.id)
      existing.mode = mode
    }
    if (!existing.group_id) {
      await db
        .prepare('UPDATE terminal_tabs SET group_id = ? WHERE id = ?')
        .run(existing.id, existing.id)
      existing.group_id = existing.id
    }
    return rowToTab(existing)
  }

  const now = new Date().toISOString()
  await db
    .prepare(`
    INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
    VALUES (?, ?, NULL, ?, 1, 0, ?, ?)
  `)
    .run(taskId, taskId, mode, taskId, now)

  return {
    id: taskId,
    taskId,
    groupId: taskId,
    label: null,
    mode: mode as TerminalTab['mode'],
    isMain: true,
    position: 0,
    createdAt: now,
    wasSpawned: false,
    hibernated: false
  }
}

/** Pure DB write — insert a new tab (new group). Used by IPC handler
 *  (`tabs:create`), REST route (`POST /api/tabs/create`) + tRPC. Caller is
 *  responsible for any IPC broadcast. */
export async function createTabRow(
  db: SlayzoneDb,
  input: CreateTerminalTabInput
): Promise<TerminalTab> {
  const id = crypto.randomUUID()
  const mode = input.mode || 'terminal'

  const maxPos = (await db
    .prepare('SELECT COALESCE(MAX(position), -1) as max_pos FROM terminal_tabs WHERE task_id = ?')
    .get(input.taskId)) as { max_pos: number }
  const position = maxPos.max_pos + 1

  const label = input.label ?? null

  const now = new Date().toISOString()
  await db
    .prepare(`
    INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `)
    .run(id, input.taskId, label, mode, position, id, now)

  return {
    id,
    taskId: input.taskId,
    groupId: id,
    label,
    mode: mode as TerminalTab['mode'],
    isMain: false,
    position,
    createdAt: now,
    wasSpawned: false,
    hibernated: false
  }
}

/** Pure DB write — update a tab. Returns null if not found.
 *  Used by IPC handler (`tabs:update`), REST route + tRPC. */
export async function updateTabRow(
  db: SlayzoneDb,
  input: UpdateTerminalTabInput
): Promise<TerminalTab | null> {
  const existing = (await db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(input.id)) as
    | TabRow
    | undefined
  if (!existing) return null

  const mode = input.mode ?? existing.mode
  const label = input.label !== undefined ? input.label : existing.label

  await db
    .prepare(`
    UPDATE terminal_tabs
    SET label = ?,
        mode = ?,
        position = COALESCE(?, position)
    WHERE id = ?
  `)
    .run(label, mode, input.position, input.id)

  const updated = (await db
    .prepare('SELECT * FROM terminal_tabs WHERE id = ?')
    .get(input.id)) as TabRow
  return rowToTab(updated)
}

/** Pure DB write — insert a new pane in the same group as the target tab.
 *  Returns null if target not found. Used by IPC handler (`tabs:split`),
 *  REST route (`POST /api/tabs/split`) + tRPC. */
export async function splitTabRow(db: SlayzoneDb, tabId: string): Promise<TerminalTab | null> {
  const target = (await db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(tabId)) as
    | TabRow
    | undefined
  if (!target) return null

  const groupId = target.group_id || target.id
  const id = crypto.randomUUID()

  const maxPos = (await db
    .prepare(
      'SELECT COALESCE(MAX(position), -1) as max_pos FROM terminal_tabs WHERE task_id = ? AND group_id = ?'
    )
    .get(target.task_id, groupId)) as { max_pos: number }
  const position = maxPos.max_pos + 1

  const now = new Date().toISOString()
  await db
    .prepare(`
    INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
    VALUES (?, ?, NULL, 'terminal', 0, ?, ?, ?)
  `)
    .run(id, target.task_id, position, groupId, now)

  return {
    id,
    taskId: target.task_id,
    groupId,
    label: null,
    mode: 'terminal',
    isMain: false,
    position,
    createdAt: now,
    wasSpawned: false,
    hibernated: false
  }
}

/** Move a tab to a different group (or its own new group if targetGroupId is
 *  null). Returns null if the tab is missing. Used by `tabs:moveToGroup` IPC
 *  handler + the `taskTerminals.moveToGroup` tRPC mutation. */
export async function moveTabToGroup(
  db: SlayzoneDb,
  tabId: string,
  targetGroupId: string | null
): Promise<TerminalTab | null> {
  const tab = (await db.prepare('SELECT * FROM terminal_tabs WHERE id = ?').get(tabId)) as
    | TabRow
    | undefined
  if (!tab) return null

  const newGroupId = targetGroupId ?? tabId // null = become own group
  await db.prepare('UPDATE terminal_tabs SET group_id = ? WHERE id = ?').run(newGroupId, tabId)
  tab.group_id = newGroupId
  return rowToTab(tab)
}

/** Delete a tab. Rejects (returns false) if the tab is the main tab or missing.
 *  Used by `tabs:delete` IPC handler + the `taskTerminals.delete` tRPC mutation. */
export async function deleteTab(db: SlayzoneDb, tabId: string): Promise<boolean> {
  const tab = (await db
    .prepare('SELECT is_main, task_id FROM terminal_tabs WHERE id = ?')
    .get(tabId)) as { is_main: number; task_id: string } | undefined
  if (!tab) return false
  if (tab.is_main === 1) return false // Can't delete main tab

  await db.prepare('DELETE FROM terminal_tabs WHERE id = ?').run(tabId)
  return true
}
