import type { SlayzoneDb } from '@slayzone/platform'
import type { ProviderConfig, Task } from '@slayzone/task/shared'
import { buildTaskCreatedEvents } from '../history.js'
import { parseTask } from './shared.js'

export interface TaskRowData {
  id: string
  projectId: string
  parentId: string | null
  title: string
  description: string | null
  descriptionFormat: 'markdown' | 'html'
  assignee: string | null
  status: string
  priority: number
  dueDate: string | null
  terminalMode: string
  providerConfig: ProviderConfig
  isTemporary: boolean
  repoName: string | null
  dangerouslySkipPermissions: boolean
  panelVisibility: string | null
  panelSizes: string | null
  browserTabs: string | null
  webPanelUrls: string | null
  /** Override updated_at (ISO string from external source). When null, SQL `datetime('now')` is used. */
  updatedAt?: string | null
}

const INSERT_SQL = `
  INSERT INTO tasks (
    id, project_id, parent_id, title, description, description_format, assignee,
    status, priority, due_date, terminal_mode, provider_config,
    claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
    is_temporary, repo_name,
    dangerously_skip_permissions, panel_visibility, panel_sizes, browser_tabs, web_panel_urls,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    COALESCE(?, datetime('now')))
`

/**
 * Canonical task INSERT seam. All task-creation paths (in-app, importers, MCP)
 * route through here. Atomically inserts row + records `task.created` activity event
 * via the `task:insert-row` named transaction (runs inside the DB worker).
 *
 * Caller responsible for: post-insert hooks (worktree provisioning, events, IPC).
 */
export async function insertTaskRow(db: SlayzoneDb, row: TaskRowData): Promise<Task | null> {
  const insertParams: unknown[] = [
    row.id,
    row.projectId,
    row.parentId,
    row.title,
    row.description,
    row.descriptionFormat,
    row.assignee,
    row.status,
    row.priority,
    row.dueDate,
    row.terminalMode,
    JSON.stringify(row.providerConfig),
    row.providerConfig['claude-code']?.flags ?? '',
    row.providerConfig['codex']?.flags ?? '',
    row.providerConfig['cursor-agent']?.flags ?? '',
    row.providerConfig['gemini']?.flags ?? '',
    row.providerConfig['opencode']?.flags ?? '',
    row.isTemporary ? 1 : 0,
    row.repoName,
    row.dangerouslySkipPermissions ? 1 : 0,
    row.panelVisibility,
    row.panelSizes,
    row.browserTabs,
    row.webPanelUrls,
    row.updatedAt ?? null
  ]

  // Activity events are derived from the task being created; all fields the
  // builder reads (id/project_id/title/status/priority) are known up-front.
  const events = buildTaskCreatedEvents({
    id: row.id,
    project_id: row.projectId,
    title: row.title,
    status: row.status,
    priority: row.priority
  } as Task)

  await db.namedTxn('task:insert-row', { insertSql: INSERT_SQL, insertParams, events })

  const fetched = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [row.id])
  return parseTask(fetched)
}
