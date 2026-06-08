import type { SlayzoneDb } from '@slayzone/platform'
import type { CreateTaskInput, ProviderConfig, Task } from '@slayzone/task/shared'
import { getDefaultStatus, isKnownStatus } from '@slayzone/projects/shared'
import { taskEvents } from '../events.js'
import { getTemplateForTask } from '../template-store.js'
import {
  colorOne,
  getEnabledModeDefaults,
  getProjectColumns,
  maybeAutoCreateWorktree,
  parseTask,
  type OpDeps
} from './shared.js'
import { insertTaskRow } from './insert.js'

export async function createTaskOp(
  db: SlayzoneDb,
  data: CreateTaskInput,
  deps: OpDeps
): Promise<Task | null> {
  const { ipcMain, onMutation } = deps
  const id = crypto.randomUUID()
  const projectColumns = await getProjectColumns(db, data.projectId)

  // Resolve template (explicit > project default > none)
  const template = await getTemplateForTask(db, data.projectId, data.templateId)

  const initialStatus =
    data.status && isKnownStatus(data.status, projectColumns)
      ? data.status
      : template?.default_status && isKnownStatus(template.default_status, projectColumns)
        ? template.default_status
        : getDefaultStatus(projectColumns)
  const terminalMode =
    data.terminalMode ??
    template?.terminal_mode ??
    (
      await db.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'default_terminal_mode'"
      )
    )?.value ??
    'claude-code'

  // Build provider_config from terminal_modes defaults + template + overrides
  const providerConfig: ProviderConfig = {}
  const legacyOverrides: Record<string, string | undefined> = {
    'claude-code': data.claudeFlags,
    codex: data.codexFlags,
    'cursor-agent': data.cursorFlags,
    gemini: data.geminiFlags,
    opencode: data.opencodeFlags
  }
  const allModes = await getEnabledModeDefaults(db)
  for (const row of allModes) {
    providerConfig[row.id] = {
      flags:
        legacyOverrides[row.id] ??
        template?.provider_config?.[row.id]?.flags ??
        row.default_flags ??
        ''
    }
  }

  const priority = data.priority ?? template?.default_priority ?? 3
  const dangerouslySkipPerms = template?.dangerously_skip_permissions ? true : false
  const panelVisibility = template?.panel_visibility
    ? JSON.stringify(template.panel_visibility)
    : null
  const browserTabs = template?.browser_tabs ? JSON.stringify(template.browser_tabs) : null
  const webPanelUrls = template?.web_panel_urls ? JSON.stringify(template.web_panel_urls) : null

  const initialTask = await insertTaskRow(db, {
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
    repoName: data.repoName ?? null,
    dangerouslySkipPermissions: dangerouslySkipPerms,
    panelVisibility,
    panelSizes: null,
    browserTabs,
    webPanelUrls
  })

  if (!initialTask) return null

  if (data.parentId) {
    const parent = (await db.get<{
      repo_name: string | null
      worktree_path: string | null
      worktree_parent_branch: string | null
      base_dir: string | null
    }>(
      'SELECT repo_name, worktree_path, worktree_parent_branch, base_dir FROM tasks WHERE id = ?',
      [data.parentId]
    )) as
      | {
          repo_name: string | null
          worktree_path: string | null
          worktree_parent_branch: string | null
          base_dir: string | null
        }
      | undefined

    if (parent) {
      await db.run(
        `
        UPDATE tasks
        SET repo_name = ?, worktree_path = ?, worktree_parent_branch = ?, base_dir = ?, updated_at = datetime('now')
        WHERE id = ?
      `,
        [
          parent.repo_name,
          parent.worktree_path,
          parent.worktree_parent_branch,
          parent.base_dir,
          id
        ]
      )
    }
  } else {
    await maybeAutoCreateWorktree(db, id, data.projectId, data.title, data.repoName)
  }
  const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [id])
  const task = parseTask(row)
  if (task) {
    ipcMain?.emit('db:tasks:create:done', null, id, data.projectId)
    taskEvents.emit('task:created', { taskId: id, projectId: data.projectId })
    onMutation?.()
  }
  return colorOne(db, task)
}
