import type { Database } from 'better-sqlite3'
import type { CreateTaskInput, ProviderConfig, Task } from '@slayzone/task/shared'
import { getDefaultStatus, isKnownStatus } from '@slayzone/projects/shared'
import { recordActivityEvents } from '@slayzone/history/main'
import { buildTaskCreatedEvents } from '../history.js'
import { taskEvents } from '../events.js'
import { getTemplateForTask } from '../template-handlers.js'
import {
  colorOne,
  getEnabledModeDefaults,
  getProjectColumns,
  maybeAutoCreateWorktree,
  parseTask,
  type OpDeps,
} from './shared.js'

export async function createTaskOp(db: Database, data: CreateTaskInput, deps: OpDeps): Promise<Task | null> {
  const { ipcMain, onMutation } = deps
  const id = crypto.randomUUID()
  const projectColumns = getProjectColumns(db, data.projectId)

  // Resolve template (explicit > project default > none)
  const template = getTemplateForTask(db, data.projectId, data.templateId)

  const initialStatus =
    data.status && isKnownStatus(data.status, projectColumns)
      ? data.status
      : (template?.default_status && isKnownStatus(template.default_status, projectColumns))
        ? template.default_status
        : getDefaultStatus(projectColumns)
  const terminalMode = data.terminalMode
    ?? template?.terminal_mode
    ?? (db.prepare("SELECT value FROM settings WHERE key = 'default_terminal_mode'")
        .get() as { value: string } | undefined)?.value
    ?? 'claude-code'

  // Build provider_config from terminal_modes defaults + template + overrides
  const providerConfig: ProviderConfig = {}
  const legacyOverrides: Record<string, string | undefined> = {
    'claude-code': data.claudeFlags, 'codex': data.codexFlags,
    'cursor-agent': data.cursorFlags, 'gemini': data.geminiFlags, 'opencode': data.opencodeFlags,
  }
  const allModes = getEnabledModeDefaults(db)
  for (const row of allModes) {
    providerConfig[row.id] = {
      flags: legacyOverrides[row.id]
        ?? template?.provider_config?.[row.id]?.flags
        ?? row.default_flags ?? ''
    }
  }

  const ccsDefaultProfile = template?.ccs_profile
    ?? (db.prepare('SELECT value FROM settings WHERE key = ?')
      .get('ccs_default_profile') as { value: string } | undefined)?.value ?? null

  const priority = data.priority ?? template?.default_priority ?? 3
  const dangerouslySkipPerms = template?.dangerously_skip_permissions ? 1 : 0
  const panelVisibility = template?.panel_visibility ? JSON.stringify(template.panel_visibility) : null
  const browserTabs = template?.browser_tabs ? JSON.stringify(template.browser_tabs) : null
  const webPanelUrls = template?.web_panel_urls ? JSON.stringify(template.web_panel_urls) : null

  const stmt = db.prepare(`
    INSERT INTO tasks (
      id, project_id, parent_id, title, description, description_format, assignee,
      status, priority, due_date, terminal_mode, provider_config,
      claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
      is_temporary, ccs_profile, repo_name,
      dangerously_skip_permissions, panel_visibility, browser_tabs, web_panel_urls
    ) VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const initialTask = db.transaction(() => {
    stmt.run(
      id, data.projectId, data.parentId ?? null,
      data.title, data.description ?? null, data.assignee ?? null,
      initialStatus, priority, data.dueDate ?? null,
      terminalMode, JSON.stringify(providerConfig),
      providerConfig['claude-code']?.flags ?? '',
      providerConfig['codex']?.flags ?? '',
      providerConfig['cursor-agent']?.flags ?? '',
      providerConfig['gemini']?.flags ?? '',
      providerConfig['opencode']?.flags ?? '',
      data.isTemporary ? 1 : 0,
      ccsDefaultProfile,
      data.repoName ?? null,
      dangerouslySkipPerms, panelVisibility, browserTabs, webPanelUrls
    )

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    const task = parseTask(row)
    if (!task) return null

    recordActivityEvents(db, buildTaskCreatedEvents(task))
    return task
  })()

  if (!initialTask) return null

  await maybeAutoCreateWorktree(db, id, data.projectId, data.title, data.repoName)
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
  const task = parseTask(row)
  if (task) {
    ipcMain.emit('db:tasks:create:done', null, id, data.projectId)
    taskEvents.emit('task:created', { taskId: id, projectId: data.projectId })
    onMutation?.()
  }
  return colorOne(db, task)
}
