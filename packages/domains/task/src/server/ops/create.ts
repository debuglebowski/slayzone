import type { Database } from 'better-sqlite3'
import type { CreateTaskInput, ProviderConfig, Task } from '@slayzone/task/shared'
import { getDefaultStatus, isKnownStatus } from '@slayzone/projects/shared'
import { taskEvents } from '../events.js'
import { getTemplateForTask } from '../template'
import {
  colorOne,
  getEnabledModeDefaults,
  getProjectColumns,
  maybeAutoCreateWorktree,
  parseTask,
  type OpDeps,
} from './shared.js'
import { insertTaskRow } from './insert.js'

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
  const dangerouslySkipPerms = template?.dangerously_skip_permissions ? true : false
  const panelVisibility = template?.panel_visibility ? JSON.stringify(template.panel_visibility) : null
  const browserTabs = template?.browser_tabs ? JSON.stringify(template.browser_tabs) : null
  const webPanelUrls = template?.web_panel_urls ? JSON.stringify(template.web_panel_urls) : null

  const initialTask = insertTaskRow(db, {
    id,
    projectId: data.projectId,
    parentId: data.parentId ?? null,
    title: data.title,
    description: data.description ?? null,
    descriptionFormat: 'markdown',
    assignee: data.assignee ?? null,
    status: initialStatus,
    priority,
    dueDate: data.dueDate ?? null,
    terminalMode,
    providerConfig,
    isTemporary: Boolean(data.isTemporary),
    ccsProfile: ccsDefaultProfile,
    repoName: data.repoName ?? null,
    dangerouslySkipPermissions: dangerouslySkipPerms,
    panelVisibility,
    browserTabs,
    webPanelUrls,
  })

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
