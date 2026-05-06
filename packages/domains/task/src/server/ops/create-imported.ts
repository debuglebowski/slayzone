import type { Database } from 'better-sqlite3'
import type { ProviderConfig, Task } from '@slayzone/task/shared'
import { taskEvents } from '../events.js'
import {
  colorOne,
  getEnabledModeDefaults,
  maybeAutoCreateWorktree,
  parseTask,
} from './shared.js'
import { insertTaskRow } from './insert.js'

/**
 * Input for creating a task from an external integration import (Linear, GitHub, ...).
 *
 * Importer is responsible for mapping external state → local fields (status, priority,
 * assignee identity, markdown→HTML for description). The task domain owns persistence,
 * worktree provisioning, activity log, and the `task:created` event.
 *
 * Note: imports do NOT emit `db:tasks:create:done` IPC. That IPC triggers
 * `pushNewTaskToProviders` which would push imported tasks back to their source.
 */
export interface CreateImportedTaskInput {
  projectId: string
  title: string
  /** Description as HTML (importer converts markdown). Null when issue has no body. */
  descriptionHtml: string | null
  status: string
  priority: number
  assignee: string | null
  /** Source-of-truth timestamp from the external system (preserves sync skew detection). */
  externalUpdatedAt: string
}

export async function createImportedTaskOp(
  db: Database,
  data: CreateImportedTaskInput,
): Promise<Task | null> {
  const id = crypto.randomUUID()

  // Default terminal mode from settings (no template path for imports)
  const terminalMode =
    (db.prepare("SELECT value FROM settings WHERE key = 'default_terminal_mode'")
      .get() as { value: string } | undefined)?.value ?? 'claude-code'

  // Provider config from terminal_modes defaults
  const providerConfig: ProviderConfig = {}
  for (const row of getEnabledModeDefaults(db)) {
    providerConfig[row.id] = { flags: row.default_flags ?? '' }
  }

  const ccsDefaultProfile =
    (db.prepare('SELECT value FROM settings WHERE key = ?')
      .get('ccs_default_profile') as { value: string } | undefined)?.value ?? null

  const initialTask = insertTaskRow(db, {
    id,
    projectId: data.projectId,
    parentId: null,
    title: data.title,
    description: data.descriptionHtml,
    descriptionFormat: 'html',
    assignee: data.assignee,
    status: data.status,
    priority: data.priority,
    dueDate: null,
    terminalMode,
    providerConfig,
    isTemporary: false,
    ccsProfile: ccsDefaultProfile,
    repoName: null,
    dangerouslySkipPermissions: false,
    panelVisibility: null,
    browserTabs: null,
    webPanelUrls: null,
    updatedAt: data.externalUpdatedAt,
  })

  if (!initialTask) return null

  await maybeAutoCreateWorktree(db, id, data.projectId, data.title, null)

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
  const task = parseTask(row)
  if (task) {
    taskEvents.emit('task:created', { taskId: id, projectId: data.projectId })
    // No db:tasks:create:done emit — prevents push-back loop to source provider.
  }
  return colorOne(db, task)
}
