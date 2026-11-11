import type { SlayzoneDb } from '@slayzone/platform'
import type { CreateTaskInput, ProviderConfig, Task } from '@slayzone/task-contracts'
import { getDefaultStatus, isKnownStatus } from '@slayzone/projects-contracts'
import {
  agentStartsOnOpen,
  AGENT_STARTUP_SETTING,
  CHAT_SETTING_KEYS,
  chatOwnsSpawnFlags,
  parseAgentStartupMode
} from '@slayzone/terminal-contracts'
import { taskEvents } from '../events.js'
import { getTemplateForTask } from '../template-store.js'
import {
  getEnabledModeDefaults,
  getProjectColumns,
  isAutoCreateWorktreeEnabled,
  maybeAutoCreateWorktree,
  notifyTaskPaths,
  parseTask,
  type OpDeps
} from './shared.js'
import { insertTaskRow } from './insert.js'

/** `err.code` on the create-time "this hub has no such project" error. */
export const PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND'

export async function createTaskOp(
  db: SlayzoneDb,
  data: CreateTaskInput,
  deps: OpDeps
): Promise<Task | null> {
  const { ipcMain, onMutation } = deps

  // A task row is FK-bound to its project, and under multi-hub federation a
  // project exists in exactly ONE hub's DB — so a create aimed at the wrong hub
  // reaches the INSERT and dies as a bare `FOREIGN KEY constraint failed`, which
  // names neither the project nor the hub. Fail here instead, with the id in the
  // message. (The REST path resolves the project before it gets this far; this
  // covers the tRPC + MCP callers, which share this op.)
  const project = await db.get<{ id: string; selected_repo: string | null }>(
    'SELECT id, selected_repo FROM projects WHERE id = ?',
    [data.projectId]
  )
  if (!project) {
    // Marked with a `code` rather than a custom class so the tRPC router can map
    // it to NOT_FOUND without importing this electron-coupled module (the
    // sidecar loads the router but not these ops).
    throw Object.assign(
      new Error(
        `Project ${data.projectId} does not exist on this hub — a task cannot be created for it here.`
      ),
      { code: PROJECT_NOT_FOUND }
    )
  }

  const projectColumns = await getProjectColumns(db, data.projectId)

  // Resolve template (explicit > project default > none)
  const template = await getTemplateForTask(db, data.projectId, data.templateId)

  const initialStatus =
    data.status && isKnownStatus(data.status, projectColumns)
      ? data.status
      : template?.default_status && isKnownStatus(template.default_status, projectColumns)
        ? template.default_status
        : getDefaultStatus(projectColumns)
  const agentId =
    data.agentId ??
    template?.agent_id ??
    (await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'default_agent_id'"))
      ?.value ??
    'claude-code'

  // Build provider_config from agents defaults + template + overrides
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
    // Claude chat's pills own its spawn flags: only a template's own flags
    // (user extras) are copied, never the mode's defaults.
    if (chatOwnsSpawnFlags(row.id)) {
      const templateFlags = template?.provider_config?.[row.id]?.flags
      providerConfig[row.id] = templateFlags !== undefined ? { flags: templateFlags } : {}
      continue
    }
    providerConfig[row.id] = {
      flags:
        legacyOverrides[row.id] ??
        template?.provider_config?.[row.id]?.flags ??
        row.default_flags ??
        ''
    }
  }

  // A template gives a new chat its starting values (decision 2): the chat's
  // computer takes them when it first starts and owns them from then on.
  for (const [mode, entry] of Object.entries(template?.provider_config ?? {})) {
    if (!entry || typeof entry !== 'object') continue
    const values = Object.fromEntries(
      CHAT_SETTING_KEYS.filter((key) => (entry as Record<string, unknown>)[key] !== undefined).map(
        (key) => [key, (entry as Record<string, unknown>)[key]]
      )
    )
    if (Object.keys(values).length) providerConfig[mode] = { ...providerConfig[mode], ...values }
  }

  const priority = data.priority ?? template?.default_priority ?? 3
  const dangerouslySkipPerms = template?.dangerously_skip_permissions ? true : false
  const panelVisibility = template?.panel_visibility
    ? JSON.stringify(template.panel_visibility)
    : null
  const browserTabs = template?.browser_tabs ? JSON.stringify(template.browser_tabs) : null
  const webPanelUrls = template?.web_panel_urls ? JSON.stringify(template.web_panel_urls) : null

  const id =
    (await reserveWarmAgent(db, data, deps, {
      selectedRepo: project.selected_repo,
      agentId,
      providerConfig
    })) ?? crypto.randomUUID()

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
    agentId,
    providerConfig,
    isTemporary: Boolean(data.isTemporary),
    repoName: data.repoName ?? null,
    dangerouslySkipPermissions: dangerouslySkipPerms,
    panelVisibility,
    panelSizes: null,
    browserTabs,
    webPanelUrls,
    externalId: data.externalId ?? null,
    externalProvider: data.externalProvider ?? null
  })

  if (!initialTask) return null

  if (data.parentId) {
    const parent = await db.get<{
      repo_name: string | null
      has_worktree: number
      worktree_parent_branch: string | null
      worktree_computer_id: string | null
      has_base_dir: number
      computer_id: string | null
    }>(
      'SELECT repo_name, has_worktree, worktree_parent_branch, worktree_computer_id, has_base_dir, computer_id FROM tasks WHERE id = ?',
      [data.parentId]
    )

    if (parent) {
      // The subtask's folders are its parent's, on the same computer. Inheriting them,
      // it takes the parent's pin too: its work runs where those folders are, and a
      // subtask left unpinned in a project defaulting elsewhere named a folder its
      // computer did not have (found by tools/migration-personas, p10-v0380-worktrees).
      // Its holder is the parent's recorded holder as is: the same folders, wherever
      // they are. Not recorded yet stays unrecorded (it resolves like the parent, by
      // the copied pin); a deleted holder stays deleted, never a live computer that
      // never had the folder.
      const inherits = parent.has_worktree === 1 || parent.has_base_dir === 1
      const holder = inherits ? parent.worktree_computer_id : null
      await db.run(
        `
        UPDATE tasks
        SET repo_name = ?, has_worktree = ?, worktree_parent_branch = ?, worktree_computer_id = ?,
            has_base_dir = ?, computer_id = CASE WHEN ? THEN ? ELSE computer_id END,
            updated_at = datetime('now')
        WHERE id = ?
      `,
        [
          parent.repo_name,
          parent.has_worktree,
          parent.worktree_parent_branch,
          holder,
          parent.has_base_dir,
          inherits ? 1 : 0,
          parent.computer_id,
          id
        ]
      )
      // The subtask's computer copies its parent's paths (robustness plan §9, P0).
      await notifyTaskPaths(id, { op: 'inherit', parentTaskId: data.parentId })
    }
  } else {
    await maybeAutoCreateWorktree(db, id, data.projectId, data.title, data.repoName)
  }
  const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [id])
  const task = parseTask(row)
  if (task) {
    ipcMain?.emit('db:tasks:create:done', null, id, data.projectId)
    taskEvents.emit('task:created', { taskId: id, projectId: data.projectId })
    // Scoped: the create wrote only this task's rows (its board row, main tab,
    // history), and the renderer places a new row via `loadBoardRows`' successor
    // ids — no whole-board reload per create.
    onMutation?.({ taskIds: [id] })
  }
  return task
}

/**
 * The id of the warm agent handed to this task, or null to mint one.
 *
 * A warm agent booted with the id of a task that did not exist yet; the task that
 * takes it is created under that id, and its first spawn adopts the agent. Asked
 * only when that spawn will happen right away and in the project root: a task the
 * caller does not open, whose agent waits behind the Start gate, or whose terminal
 * runs in a worktree, a child repo or a parent's workspace would never claim the
 * agent, and a reservation nobody claims is a booted agent killed for nothing. The
 * pool itself checks what it alone knows (provider, flags, computer).
 */
async function reserveWarmAgent(
  db: SlayzoneDb,
  data: CreateTaskInput,
  deps: OpDeps,
  task: { selectedRepo: string | null; agentId: string; providerConfig: ProviderConfig }
): Promise<string | null> {
  if (!deps.reserveWarmTaskId || !data.openAfterCreate) return null
  if (data.parentId || data.repoName || task.selectedRepo) return null
  const startup = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
    AGENT_STARTUP_SETTING
  ])
  // The task's main tab is created `new` (insertTaskRow), so the same rule the task
  // view applies on open decides here whether that open will spawn.
  if (
    !agentStartsOnOpen({
      mode: parseAgentStartupMode(startup?.value),
      state: 'new',
      isTemporary: Boolean(data.isTemporary),
      shown: true
    })
  ) {
    return null
  }
  if (await isAutoCreateWorktreeEnabled(db, data.projectId)) return null
  return deps.reserveWarmTaskId({
    projectId: data.projectId,
    mode: task.agentId,
    flags: task.providerConfig[task.agentId]?.flags ?? null
  })
}
