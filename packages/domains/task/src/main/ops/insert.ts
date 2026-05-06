import type { Database } from 'better-sqlite3'
import { recordActivityEvents } from '@slayzone/history/server'
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
  ccsProfile: string | null
  repoName: string | null
  dangerouslySkipPermissions: boolean
  panelVisibility: string | null
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
    is_temporary, ccs_profile, repo_name,
    dangerously_skip_permissions, panel_visibility, browser_tabs, web_panel_urls,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    COALESCE(?, datetime('now')))
`

/**
 * Canonical task INSERT seam. All task-creation paths (in-app, importers, MCP)
 * route through here. Atomically inserts row + records `task.created` activity event.
 *
 * Caller responsible for: post-insert hooks (worktree provisioning, events, IPC).
 */
export function insertTaskRow(db: Database, row: TaskRowData): Task | null {
  const stmt = db.prepare(INSERT_SQL)
  return db.transaction(() => {
    stmt.run(
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
      row.ccsProfile,
      row.repoName,
      row.dangerouslySkipPermissions ? 1 : 0,
      row.panelVisibility,
      row.browserTabs,
      row.webPanelUrls,
      row.updatedAt ?? null,
    )

    const fetched = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id) as Record<string, unknown> | undefined
    const task = parseTask(fetched)
    if (!task) return null

    recordActivityEvents(db, buildTaskCreatedEvents(task))
    return task
  })()
}
