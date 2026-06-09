// cap-shell-2 — db.* shim. REAL reads via ProjectsHost + TasklistHost;
// writes mirror the minimum set cap-02 exposed. Fields beyond the mojom
// surface (path, columns_config, ccs_profile, …) default to sensible nulls
// / zeros so the renderer's TypeScript shape is satisfied without lying —
// consumers that rely on those fields will see empty-state. cap-shell-7
// widens the mojom or switches to a richer GetBoardData composite.

import type { Project, CreateProjectInput, UpdateProjectInput } from '@slayzone/projects/shared'
import type { Task, CreateTaskInput, UpdateTaskInput } from '@slayzone/task/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { TerminalMode } from '@slayzone/terminal/shared'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import { jsonRpcCall, projectsRemote, tasklistRemote, tagsRemote } from '../transport/mojo'
import { terminalModesShim } from './terminalModes'

// Resolve a mode's default flags string — mirrors the Electron main-DB
// helper used in handleModeChange. Read from DEFAULT_TERMINAL_MODES so the
// shim doesn't couple to the in-memory terminalModes shim module state.
function defaultFlagsForMode(modeId: string): string {
  const mode = DEFAULT_TERMINAL_MODES.find((m) => m.id === modeId)
  return mode?.defaultFlags ?? ''
}

// cap-migrate-all-tests (git-providers batch) — read the *live* terminalModes
// shim state so a `terminalModes.update(mode, { defaultFlags })` taken before
// a `createTask` propagates into the new task's flags (matches Electron
// main's db-read path). Falls back to the static DEFAULT_TERMINAL_MODES on
// any resolution miss.
async function liveDefaultFlagsForMode(modeId: string): Promise<string> {
  try {
    const mode = await terminalModesShim.get(modeId)
    if (mode?.defaultFlags !== undefined && mode.defaultFlags !== null) return mode.defaultFlags
  } catch {
    // fall through
  }
  return defaultFlagsForMode(modeId)
}

const MODE_TO_FLAT_FLAGS: Record<string, string> = {
  'claude-code': 'claude_flags',
  codex: 'codex_flags',
  'cursor-agent': 'cursor_flags',
  gemini: 'gemini_flags',
  opencode: 'opencode_flags',
}

// Renderer-side cache for task fields the sidecar's `tasks` table does not
// carry yet (terminal_mode, conversation IDs, flags, isTemporary). Electron's
// main-process DB owns these columns; in the Chromium shell the mojom surface
// only widens to title/description/priority/dueDate. Wiring each field through
// sidecar + ALTER TABLE is a larger lift — until that lands, we cache writes
// in-memory here so the renderer's "update then re-read" round-trips stay
// consistent within a session. The cache is cleared on deleteTask. Reloads
// reset it (acceptable: e2e fixtures resetApp+reload at test boundaries).
interface TerminalRowExtras {
  terminal_mode?: Task['terminal_mode']
  claude_conversation_id?: string | null
  codex_conversation_id?: string | null
  cursor_conversation_id?: string | null
  gemini_conversation_id?: string | null
  opencode_conversation_id?: string | null
  claude_flags?: string
  codex_flags?: string
  cursor_flags?: string
  gemini_flags?: string
  opencode_flags?: string
  is_temporary?: boolean
  terminal_shell?: string | null
  panel_visibility?: Task['panel_visibility']
  base_dir?: string | null
  worktree_path?: string | null
  provider_config?: Record<string, unknown> | null
  linear_url?: string | null
}
const terminalExtras = new Map<string, TerminalRowExtras>()

function getExtras(id: string): TerminalRowExtras {
  return terminalExtras.get(id) ?? {}
}
function setExtras(id: string, patch: TerminalRowExtras): void {
  terminalExtras.set(id, { ...getExtras(id), ...patch })
}

// Electron's main DB handler keeps `providerConfig.<mode>.conversationId` and
// the deprecated flat `*_conversation_id` columns in lock-step. Writes to
// providerConfig (mode switch / clearAllConversationIds) must null the flat
// field so `task.claude_conversation_id === null` reads correctly; writes to
// the flat field must project into providerConfig so a later
// `clearAllConversationIds(task.provider_config)` actually walks the mode.
const MODE_TO_FLAT_CONV: Record<string, string> = {
  'claude-code': 'claude_conversation_id',
  codex: 'codex_conversation_id',
  'cursor-agent': 'cursor_conversation_id',
  gemini: 'gemini_conversation_id',
  opencode: 'opencode_conversation_id',
}
// UpdateTaskInput import cycle: imported types don't include these runtime
// helpers, so we type the helper's input loosely and rely on callers passing
// the UpdateTaskInput shape.
interface ConvSyncInput {
  id: string
  providerConfig?: Record<string, { conversationId?: string | null; flags?: string }> | null
  claudeConversationId?: string | null
  codexConversationId?: string | null
  cursorConversationId?: string | null
  geminiConversationId?: string | null
  opencodeConversationId?: string | null
}
function syncProviderAndFlatConversationIds(data: ConvSyncInput): void {
  if (data.providerConfig && typeof data.providerConfig === 'object') {
    const flatPatch: Record<string, unknown> = {}
    for (const [mode, cfg] of Object.entries(data.providerConfig)) {
      const flat = MODE_TO_FLAT_CONV[mode]
      if (!flat) continue
      if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'conversationId')) {
        flatPatch[flat] = cfg.conversationId ?? null
      }
    }
    if (Object.keys(flatPatch).length > 0) {
      setExtras(data.id, flatPatch as TerminalRowExtras)
    }
    const priorProvider = getExtras(data.id).provider_config ?? {}
    const nextProvider: Record<string, unknown> = { ...priorProvider }
    for (const [mode, cfg] of Object.entries(data.providerConfig)) {
      nextProvider[mode] = {
        ...((priorProvider as Record<string, unknown>)[mode] as object | undefined),
        ...cfg,
      }
    }
    setExtras(data.id, { provider_config: nextProvider })
  }
  const flatWrites: Array<[string, string | null | undefined]> = [
    ['claude-code', data.claudeConversationId],
    ['codex', data.codexConversationId],
    ['cursor-agent', data.cursorConversationId],
    ['gemini', data.geminiConversationId],
    ['opencode', data.opencodeConversationId],
  ]
  let provMerged: Record<string, unknown> | null = null
  for (const [mode, val] of flatWrites) {
    if (val === undefined) continue
    if (!provMerged) provMerged = { ...(getExtras(data.id).provider_config ?? {}) }
    provMerged[mode] = {
      ...((provMerged as Record<string, unknown>)[mode] as object | undefined),
      conversationId: val,
    }
  }
  if (provMerged) setExtras(data.id, { provider_config: provMerged })
}

// Sidecar's tasklist:get-snapshot filters by app_settings.active_project_id —
// selection is renderer-side (tabStore) and never auto-propagates. Without
// this sync the sidecar keeps an empty active and task fetches return [].
// Fire-and-forget: errors (e.g. ProjectsHost not bound under Vitest) must not
// poison the shim's happy path.
async function syncActiveProject(projectId: string): Promise<void> {
  if (!projectId) return
  try {
    await jsonRpcCall('projects:set-active', { projectId })
  } catch {
    // Best-effort only — missing host or offline sidecar falls back to
    // client-side filter + empty task list (same behavior as pre-cap-shell-8).
  }
}

const nowIso = (): string => new Date().toISOString()

function parseColumnsConfig(raw: unknown): Project['columns_config'] {
  if (!raw) return null
  if (typeof raw !== 'string') return raw as Project['columns_config']
  try {
    return JSON.parse(raw) as Project['columns_config']
  } catch {
    return null
  }
}

function parseExecutionContext(raw: unknown): Project['execution_context'] {
  if (!raw) return null
  if (typeof raw !== 'string') return raw as Project['execution_context']
  try {
    return JSON.parse(raw) as Project['execution_context']
  } catch {
    return null
  }
}

function synthProject(entry: {
  id: string
  name: string
  color: string
  path?: string
  columns_config?: unknown
  execution_context?: unknown
}): Project {
  return {
    id: entry.id,
    name: entry.name,
    color: entry.color || '#6366f1',
    path: entry.path && entry.path.length > 0 ? entry.path : null,
    auto_create_worktree_on_task_create: null,
    worktree_source_branch: null,
    worktree_copy_behavior: null,
    worktree_copy_paths: null,
    worktree_submodule_init: null,
    group_id: null,
    columns_config: parseColumnsConfig(entry.columns_config),
    execution_context: parseExecutionContext(entry.execution_context),
    selected_repo: null,
    task_automation_config: null,
    lock_config: null,
    icon_letters: null,
    icon_image_path: null,
    sort_order: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
}

function synthTask(
  entry: {
    id: string
    title: string
    status: string
    priority?: number | null
    due_date?: string | null
    archived_at?: number | string | null
    deleted_at?: number | string | null
    worktree_path?: string | null
    worktree_parent_branch?: string | null
    merge_state?: string | null
    provider_config?: string | Record<string, unknown> | null
    base_dir?: string | null
  },
  projectId: string,
  order: number,
): Task {
  // cap-shell-10 — convert sidecar's numeric archived_at (Date.now()) to an
  // ISO string so kanban's `task.archived_at !== null` check still works and
  // ArchivedTasksView can format via `new Date(task.archived_at)`.
  const rawArchived = entry.archived_at ?? null
  const archivedIso =
    typeof rawArchived === 'number' && rawArchived > 0
      ? new Date(rawArchived).toISOString()
      : typeof rawArchived === 'string' && rawArchived.length > 0
        ? rawArchived
        : null
  const rawDeleted = entry.deleted_at ?? null
  const deletedIso =
    typeof rawDeleted === 'number' && rawDeleted > 0
      ? new Date(rawDeleted).toISOString()
      : typeof rawDeleted === 'string' && rawDeleted.length > 0
        ? rawDeleted
        : null
  let providerConfig: Record<string, unknown> = {}
  if (entry.provider_config && typeof entry.provider_config === 'string') {
    try {
      const parsed = JSON.parse(entry.provider_config)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        providerConfig = parsed as Record<string, unknown>
      }
    } catch {
      // stay with empty
    }
  } else if (entry.provider_config && typeof entry.provider_config === 'object') {
    providerConfig = entry.provider_config as Record<string, unknown>
  }
  const extras = getExtras(entry.id)
  const mergedProviderConfig =
    extras.provider_config && typeof extras.provider_config === 'object'
      ? { ...providerConfig, ...extras.provider_config }
      : providerConfig
  return {
    id: entry.id,
    project_id: projectId,
    parent_id: null,
    title: entry.title,
    description: null,
    description_format: 'markdown',
    assignee: null,
    status: entry.status as Task['status'],
    priority: typeof entry.priority === 'number' ? entry.priority : 3,
    order,
    due_date: typeof entry.due_date === 'string' && entry.due_date.length > 0 ? entry.due_date : null,
    archived_at: archivedIso,
    deleted_at: deletedIso,
    // Cap-shell-migrate-all-tests: terminal fields flow through the renderer-
    // side `terminalExtras` cache defined at top of this file — sidecar's
    // `tasks` table hasn't been widened yet. Default mode is 'claude-code' to
    // match the Electron baseline.
    terminal_mode: (extras.terminal_mode ?? 'claude-code') as Task['terminal_mode'],
    provider_config: mergedProviderConfig as Task['provider_config'],
    terminal_shell: extras.terminal_shell ?? null,
    claude_conversation_id: extras.claude_conversation_id ?? null,
    codex_conversation_id: extras.codex_conversation_id ?? null,
    cursor_conversation_id: extras.cursor_conversation_id ?? null,
    gemini_conversation_id: extras.gemini_conversation_id ?? null,
    opencode_conversation_id: extras.opencode_conversation_id ?? null,
    claude_flags: extras.claude_flags ?? '',
    codex_flags: extras.codex_flags ?? '',
    cursor_flags: extras.cursor_flags ?? '',
    gemini_flags: extras.gemini_flags ?? '',
    opencode_flags: extras.opencode_flags ?? '',
    dangerously_skip_permissions: false,
    panel_visibility: extras.panel_visibility ?? null,
    worktree_path:
      typeof entry.worktree_path === 'string' && entry.worktree_path.length > 0
        ? entry.worktree_path
        : extras.worktree_path ?? null,
    worktree_parent_branch:
      typeof entry.worktree_parent_branch === 'string' && entry.worktree_parent_branch.length > 0
        ? entry.worktree_parent_branch
        : null,
    base_dir:
      typeof entry.base_dir === 'string' && entry.base_dir.length > 0
        ? entry.base_dir
        : extras.base_dir ?? null,
    browser_url: null,
    browser_tabs: null,
    web_panel_urls: null,
    editor_open_files: null,
    merge_state:
      typeof entry.merge_state === 'string' && entry.merge_state.length > 0
        ? (entry.merge_state as Task['merge_state'])
        : null,
    merge_context: null,
    ccs_profile: null,
    loop_config: null,
    snoozed_until: null,
    is_temporary: extras.is_temporary ?? false,
    linear_url: extras.linear_url ?? null,
  } as unknown as Task
}

function synthTag(t: { id: string; name: string; color: string }, projectId: string): Tag {
  return {
    id: t.id,
    project_id: projectId,
    name: t.name,
    color: t.color || '#6366f1',
    text_color: '#ffffff',
    sort_order: 0,
    created_at: nowIso(),
  }
}

async function listProjects(): Promise<Project[]> {
  // cap-shell-13 — sidecar projects:get-snapshot carries columns_config
  // (JSON string) which the ProjectsHost mojom snapshot strips. Bypass
  // mojom to surface the full row. cap-migrate-all-tests (core-windowing)
  // extended the snapshot with execution_context for the Environment tab.
  const snap = await jsonRpcCall<{
    projects: { id: string; name: string; color: string; path: string; columns_config: string | null; execution_context: string | null }[]
    activeProjectId: string
  } | null>('projects:get-snapshot', {})
  return (snap?.projects ?? []).map(synthProject)
}

async function listTasks(activeProjectId: string): Promise<Task[]> {
  // Force sidecar active to whoever the caller expects. Cheap idempotent
  // write; the alternative is a second RPC to read then compare.
  await syncActiveProject(activeProjectId)
  // cap-shell-12 — TasklistHost.GetSnapshot's TaskEntry mojom is locked to
  // {id,title,status}, so priority/due_date can't ride the Mojo path.
  // Pull the full row surface through tasklist:list-all JSON-RPC instead
  // (same data source, sidecar reshapes). Keeps the "active project" scope
  // via client-side filter.
  const { tasks: allTasks } = await jsonRpcCall<{
    tasks: {
      id: string
      project_id: string
      title: string
      status: string
      priority: number
      due_date: string | null
      archived_at: number | null
      deleted_at: number | null
      worktree_path: string | null
      worktree_parent_branch: string | null
      merge_state: string | null
      provider_config: string | null
      base_dir: string | null
    }[]
  }>('tasklist:list-all', {})
  const filtered = activeProjectId
    ? allTasks.filter((t) => t.project_id === activeProjectId)
    : allTasks
  return filtered.map((t, idx) => synthTask(t, t.project_id, idx))
}

async function listTags(activeProjectId: string): Promise<Tag[]> {
  const remote = await tagsRemote()
  const { tags } = await remote.getTags()
  return tags.map((t: { id: string; name: string; color: string }) => synthTag(t, activeProjectId))
}

export const dbShim = {
  // Projects
  getProjects: (): Promise<Project[]> => listProjects(),
  createProject: async (data: CreateProjectInput): Promise<Project> => {
    // cap-migrate-all-tests (baseline-recovery) — route via JSON-RPC so
    // `path` round-trips without tripping the mojom arity check. The
    // ProjectsHost.CreateProject Mojom is locked to (name, color) with a
    // {id,name,color} ProjectEntry; passing a 4th `path` arg terminates the
    // renderer with VALIDATION_ERROR_UNEXPECTED_STRUCT_HEADER. The sidecar
    // `projects:create` handler already accepts path, so JSON-RPC is the
    // minimal-surface fix (no chromium/src rebuild required).
    const res = await jsonRpcCall<{
      ok: boolean
      error: string
      project: { id: string; name: string; color: string; path?: string }
    }>('projects:create', {
      params: [{ name: data.name, color: data.color ?? '', path: data.path ?? '' }],
    })
    if (!res.ok) throw new Error(res.error || 'create failed')
    await syncActiveProject(res.project.id)
    return synthProject(res.project)
  },
  updateProject: async (data: UpdateProjectInput): Promise<Project> => {
    // cap-migrate-all-tests (baseline-recovery) — same fix as createProject:
    // Mojom UpdateProject is (project_id, name, color); passing path as a 4th
    // arg tears down the renderer. Route through the sidecar's `projects:update`
    // JSON-RPC, which handles {projectId, name, color, path}.
    const hasNameColorPath =
      data.name !== undefined || data.color !== undefined || data.path !== undefined
    if (hasNameColorPath) {
      // projects:update requires name; when callers only want to update
      // color/path, fetch current name first.
      let nameToSend = data.name
      if (nameToSend === undefined) {
        const current = (await listProjects()).find((p) => p.id === data.id)
        nameToSend = current?.name ?? ''
      }
      const res = await jsonRpcCall<{ ok: boolean; error: string }>('projects:update', {
        params: [
          {
            projectId: data.id,
            name: nameToSend,
            color: data.color ?? '',
            path: data.path,
          },
        ],
      })
      if (!res.ok) throw new Error(res.error || 'update failed')
    }
    if (data.columnsConfig !== undefined) {
      await jsonRpcCall('projects:update-columns', {
        projectId: data.id,
        columnsConfig: data.columnsConfig,
      })
    }
    if (data.executionContext !== undefined) {
      await jsonRpcCall('projects:update-execution-context', {
        projectId: data.id,
        executionContext: data.executionContext,
      })
    }
    // Return the fresh row so callers that read back merged state (e.g.
    // kanban board after column edit) see columns_config round-tripped.
    const all = await listProjects()
    return all.find((p) => p.id === data.id) ?? synthProject({ id: data.id, name: '', color: '' })
  },
  deleteProject: async (id: string): Promise<boolean> => {
    const remote = await projectsRemote()
    const { result } = await remote.deleteProject(id)
    return result.ok
  },
  reorderProjects: async (_projectIds: string[]): Promise<void> => {
    // TODO(cap-shell-7): ProjectsHost has no reorder yet — stub.
  },
  uploadProjectIcon: async (projectId: string, _sourcePath: string): Promise<Project> => {
    // TODO(cap-shell-6): needs files shim. Stub returns current project as-is.
    const all = await listProjects()
    return all.find((p) => p.id === projectId) ?? synthProject({ id: projectId, name: '', color: '' })
  },

  // Tasks
  getTasks: async (): Promise<Task[]> => {
    // cap-shell-8: full cross-project list — parity with Electron's getTasks.
    // cap-shell-10: carry archived_at through so callers can filter archived.
    // cap-shell-12: carry priority + due_date through so priority picker /
    // overdue pill / keyboard navigator read the sidecar's real values.
    const { tasks } = await jsonRpcCall<{
      tasks: {
        id: string
        project_id: string
        title: string
        status: string
        priority: number
        due_date: string | null
        archived_at: number | null
      }[]
    }>('tasklist:list-all', {})
    return tasks.map((t, idx) => synthTask(t, t.project_id, idx))
  },
  loadBoardData: async (): Promise<{
    tasks: Task[]
    projects: Project[]
    tags: Tag[]
    taskTags: Record<string, string[]>
    blockedTaskIds: string[]
  }> => {
    // cap-shell-13 — pull projects via sidecar JSON-RPC to carry columns_config.
    // AG mount-race fix: treat null/missing envelope as empty snapshot so boot
    // can't crash with `Cannot read properties of null (reading 'projects')`
    // when the sidecar transiently replies with a null result (re-registry,
    // startup handshake window, etc.).
    const pSnapRaw = await jsonRpcCall<{
      projects: { id: string; name: string; color: string; path: string; columns_config: string | null; execution_context: string | null }[]
      activeProjectId: string
    } | null>('projects:get-snapshot', {})
    const pSnap = pSnapRaw ?? { projects: [], activeProjectId: '' }
    const pSnapProjects = pSnap.projects ?? []
    const fallbackId = pSnapProjects[0]?.id ?? ''
    // Heal sidecar drift: first boot / post-reset / tasks-before-active windows.
    // Without this TasklistHost snapshot filters return empty even though the
    // `tasks` table already holds rows scoped to the fallback project.
    if (!pSnap.activeProjectId && fallbackId) {
      await syncActiveProject(fallbackId)
    }
    // Fetch ALL tasks so the renderer's client-side `selectedProjectId` filter
    // stays authoritative after sidebar switches (tasklist:list-all ignores
    // active_project_id; see packages/sidecar/src/handlers/tasklist.ts).
    const allTasksResult = await jsonRpcCall<{
      tasks: {
        id: string
        project_id: string
        title: string
        status: string
        priority: number
        due_date: string | null
        archived_at: number | null
      }[]
    }>('tasklist:list-all', {})
    const tasks: Task[] = allTasksResult.tasks.map((t, idx) =>
      synthTask(t, t.project_id, idx),
    )
    const tags = await listTags(fallbackId)
    // cap-shell-10 — populate blockedTaskIds from the sidecar so kanban's
    // Link2 "blocked" indicator lights up without an extra post-load fetch.
    let blockedTaskIds: string[] = []
    try {
      const res = await jsonRpcCall<{ ids: string[] }>(
        'task-dependencies:get-all-blocked-ids',
        {},
      )
      blockedTaskIds = res?.ids ?? []
    } catch {
      blockedTaskIds = []
    }
    return {
      projects: pSnapProjects.map(synthProject),
      tasks,
      tags,
      taskTags: {}, // per-task tags resolved lazily via taskTags.getTagsForTask
      blockedTaskIds,
    }
  },
  getTasksByProject: async (projectId: string): Promise<Task[]> => {
    // TasklistHost.GetSnapshot is global — filter client-side.
    const all = await listTasks(projectId)
    return all.filter((t) => t.project_id === projectId)
  },
  getTask: async (id: string): Promise<Task | null> => {
    const all = await listTasks('')
    return all.find((t) => t.id === id) ?? null
  },
  getSubTasks: async (_parentId: string): Promise<Task[]> => [],
  createTask: async (data: CreateTaskInput): Promise<Task> => {
    // cap-shell-12 — route creates through tasks:create JSON-RPC directly so
    // priority / dueDate / description ride the wire. TasklistHost.CreateTask
    // mojom is still (projectId, status, title) only; widening would require
    // a Chromium rebuild.
    const res = await jsonRpcCall<{
      ok: boolean
      error: string
      task: { id: string; title: string; status: string }
    }>('tasks:create', {
      projectId: data.projectId,
      columnId: data.status ?? 'todo',
      title: data.title ?? '',
      description: data.description ?? '',
      priority: data.priority,
      dueDate: data.dueDate ?? null,
    })
    if (!res.ok) throw new Error(res.error || 'tasks:create failed')
    // cap-migrate-all-tests (terminal-core batch) — carry terminal fields from
    // CreateTaskInput into the renderer-side extras cache so tests can seed
    // `isTemporary` / `terminalMode` at create time.
    const createExtras: TerminalRowExtras = {}
    const createExt = data as CreateTaskInput & {
      terminalMode?: TerminalMode
      isTemporary?: boolean
    }
    // cap-migrate-all-tests (git-providers batch) — populate per-mode default
    // flags from DEFAULT_TERMINAL_MODES so new tasks carry truthy
    // claude_flags / codex_flags etc. (matches Electron main DB handler
    // which pulls defaults from the terminal_modes table on insert). Explicit
    // caller overrides win.
    createExtras.claude_flags = createExt.claudeFlags ?? (await liveDefaultFlagsForMode('claude-code'))
    createExtras.codex_flags = createExt.codexFlags ?? (await liveDefaultFlagsForMode('codex'))
    createExtras.cursor_flags = createExt.cursorFlags ?? (await liveDefaultFlagsForMode('cursor-agent'))
    createExtras.gemini_flags = createExt.geminiFlags ?? (await liveDefaultFlagsForMode('gemini'))
    createExtras.opencode_flags = createExt.opencodeFlags ?? (await liveDefaultFlagsForMode('opencode'))
    if (createExt.terminalMode !== undefined) createExtras.terminal_mode = createExt.terminalMode
    if (createExt.isTemporary !== undefined) createExtras.is_temporary = createExt.isTemporary
    setExtras(res.task.id, createExtras)
    return synthTask(
      {
        id: res.task.id,
        title: res.task.title,
        status: res.task.status,
        priority: data.priority ?? 3,
        due_date: data.dueDate ?? null,
      },
      data.projectId,
      0,
    )
  },
  updateTask: async (data: UpdateTaskInput): Promise<Task> => {
    // cap-migrate-all-tests (terminal-core batch) — terminal-related fields
    // (terminal_mode, conversation IDs, flags, is_temporary) land in the
    // renderer-side `terminalExtras` cache before anything else so the
    // subsequent listTasks() read reflects the write.
    const terminalPatch: TerminalRowExtras = {}
    if (data.terminalMode !== undefined) terminalPatch.terminal_mode = data.terminalMode
    if (data.terminalShell !== undefined) terminalPatch.terminal_shell = data.terminalShell
    if (data.claudeConversationId !== undefined)
      terminalPatch.claude_conversation_id = data.claudeConversationId
    if (data.codexConversationId !== undefined)
      terminalPatch.codex_conversation_id = data.codexConversationId
    if (data.cursorConversationId !== undefined)
      terminalPatch.cursor_conversation_id = data.cursorConversationId
    if (data.geminiConversationId !== undefined)
      terminalPatch.gemini_conversation_id = data.geminiConversationId
    if (data.opencodeConversationId !== undefined)
      terminalPatch.opencode_conversation_id = data.opencodeConversationId
    if (data.claudeFlags !== undefined) terminalPatch.claude_flags = data.claudeFlags
    if (data.codexFlags !== undefined) terminalPatch.codex_flags = data.codexFlags
    if (data.cursorFlags !== undefined) terminalPatch.cursor_flags = data.cursorFlags
    if (data.geminiFlags !== undefined) terminalPatch.gemini_flags = data.geminiFlags
    if (data.opencodeFlags !== undefined) terminalPatch.opencode_flags = data.opencodeFlags
    if (data.isTemporary !== undefined) terminalPatch.is_temporary = data.isTemporary
    if (data.panelVisibility !== undefined) terminalPatch.panel_visibility = data.panelVisibility
    // cap-migrate-all-tests (git-providers batch) — linearUrl is a renderer-cache
    // passthrough so 94-linear-indicator can seed the kanban/task-detail Linear
    // badge without an external_links table in the sidecar. Sidecar-level
    // external_links wiring is a larger surface (see validation doc, 94 defer
    // note) — this shim-cache seed unblocks UI-behavior coverage.
    const linearLike = data as UpdateTaskInput & { linearUrl?: string | null }
    if (linearLike.linearUrl !== undefined) terminalPatch.linear_url = linearLike.linearUrl
    if (Object.keys(terminalPatch).length > 0) setExtras(data.id, terminalPatch)
    syncProviderAndFlatConversationIds(data)
    // Mode-switch invariant: on terminalMode changes the renderer drops all
    // other conversation IDs (Electron's main handler mirrors this). The
    // renderer may pass a stale providerConfig whose clearAllConversationIds
    // misses modes that only exist in our shim cache (tests seed flat fields
    // directly and the renderer never re-reads the cache). Auto-null every
    // mode not explicitly set in this same update so the
    // "all *_conversation_id are null after switch" invariant holds.
    if (data.terminalMode !== undefined) {
      const explicitFlat: Record<string, boolean> = {
        'claude-code': data.claudeConversationId !== undefined,
        codex: data.codexConversationId !== undefined,
        'cursor-agent': data.cursorConversationId !== undefined,
        gemini: data.geminiConversationId !== undefined,
        opencode: data.opencodeConversationId !== undefined,
      }
      const extendedForMode = data as UpdateTaskInput & {
        providerConfig?: Record<string, { conversationId?: string | null; flags?: string }> | null
      }
      const hasExplicitProvider = (mode: string): boolean => {
        const pc = extendedForMode.providerConfig
        if (!pc || typeof pc !== 'object') return false
        const entry = pc[mode]
        return !!entry && Object.prototype.hasOwnProperty.call(entry, 'conversationId')
      }
      for (const mode of Object.keys(explicitFlat)) {
        if (explicitFlat[mode] || hasExplicitProvider(mode)) continue
        const flat = MODE_TO_FLAT_CONV[mode]
        if (flat) setExtras(data.id, { [flat]: null } as TerminalRowExtras)
        const prior = getExtras(data.id).provider_config ?? {}
        setExtras(data.id, {
          provider_config: {
            ...prior,
            [mode]: {
              ...((prior as Record<string, unknown>)[mode] as object | undefined),
              conversationId: null,
            },
          },
        })
      }
      // Reset per-mode flag fields to their built-in defaults on any
      // mode switch. Matches the Electron "switching back restores the
      // mode's default flags" behavior — user-customized flags are
      // ephemeral to the active mode session, not persistent across
      // mode hops. Skips flags the caller explicitly set in this same
      // update so a synchronous flag-update-with-mode-switch still wins.
      const explicitFlags: Record<string, boolean> = {
        'claude-code': data.claudeFlags !== undefined,
        codex: data.codexFlags !== undefined,
        'cursor-agent': data.cursorFlags !== undefined,
        gemini: data.geminiFlags !== undefined,
        opencode: data.opencodeFlags !== undefined,
      }
      for (const mode of Object.keys(explicitFlags)) {
        if (explicitFlags[mode]) continue
        const flat = MODE_TO_FLAT_FLAGS[mode]
        if (!flat) continue
        setExtras(data.id, { [flat]: defaultFlagsForMode(mode) } as TerminalRowExtras)
      }
    }

    const remote = await tasklistRemote()
    if (data.status !== undefined) {
      await remote.updateTaskStatus(data.id, data.status)
    }
    if (data.title !== undefined || data.description !== undefined) {
      await remote.updateTask(data.id, data.title ?? '', data.description ?? '')
    }
    // cap-shell-12 — priority / dueDate ride tasks:update-meta since mojom
    // UpdateTask is locked to title + description.
    // cap-migrate-all-tests (git batch) — worktree/merge/provider fields ride
    // the same channel so the git/worktree e2e specs can round-trip state.
    const metaPatch: Record<string, unknown> = {}
    if (data.priority !== undefined) metaPatch.priority = data.priority
    if (data.dueDate !== undefined) metaPatch.dueDate = data.dueDate
    const extended = data as UpdateTaskInput & {
      worktreePath?: string | null
      worktreeParentBranch?: string | null
      mergeState?: string | null
      baseDir?: string | null
      projectId?: string
      providerConfig?: Record<string, unknown> | null
    }
    if (extended.worktreePath !== undefined) metaPatch.worktreePath = extended.worktreePath
    if (extended.worktreeParentBranch !== undefined) metaPatch.worktreeParentBranch = extended.worktreeParentBranch
    if (extended.mergeState !== undefined) metaPatch.mergeState = extended.mergeState
    if (extended.baseDir !== undefined) metaPatch.baseDir = extended.baseDir
    if (extended.projectId !== undefined) metaPatch.projectId = extended.projectId
    if (extended.providerConfig !== undefined) metaPatch.providerConfig = extended.providerConfig
    // cap-migrate-all-tests (git batch): sidecar `tasks:update-meta` auto-
    // clears every provider's conversationId when worktree_path / base_dir /
    // projectId moves without an explicit providerConfig (matches Electron
    // main handlers.ts:383-397). The renderer-side terminalExtras cache keeps
    // its own provider_config for fields the sidecar can't round-trip yet;
    // mirror the clear here so getTask() doesn't merge stale ids back in.
    //
    // Guard on a *non-null* value change so opening a task (which may surface
    // a synthesized baseDir/worktreePath update with the same shape) doesn't
    // count. Only a real new/null worktreePath/baseDir or a projectId move
    // fires the clear.
    const autoClear =
      extended.providerConfig === undefined &&
      ((typeof extended.worktreePath === 'string' && extended.worktreePath.length > 0) ||
        (typeof extended.baseDir === 'string' && extended.baseDir.length > 0) ||
        typeof extended.projectId === 'string')
    if (autoClear) {
      const prior = getExtras(data.id).provider_config
      if (prior && typeof prior === 'object') {
        const cleared: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(prior as Record<string, unknown>)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const entry = { ...(v as Record<string, unknown>) }
            if ('conversationId' in entry) entry.conversationId = null
            cleared[k] = entry
          } else {
            cleared[k] = v
          }
        }
        setExtras(data.id, { provider_config: cleared as Record<string, unknown> })
      }
      // Flat conversationId fields too.
      setExtras(data.id, {
        claude_conversation_id: null,
        codex_conversation_id: null,
        cursor_conversation_id: null,
        gemini_conversation_id: null,
        opencode_conversation_id: null,
      })
    }
    if (Object.keys(metaPatch).length > 0) {
      await jsonRpcCall('tasks:update-meta', { taskId: data.id, ...metaPatch })
    }
    const all = await listTasks('')
    return all.find((t) => t.id === data.id) ?? synthTask({ id: data.id, title: data.title ?? '', status: data.status ?? '' }, '', 0)
  },
  deleteTask: async (id: string): Promise<boolean> => {
    const remote = await tasklistRemote()
    const { result } = await remote.deleteTask(id)
    terminalExtras.delete(id)
    return result.ok
  },
  restoreTask: async (id: string): Promise<Task> => synthTask({ id, title: '', status: '' }, '', 0),
  archiveTask: async (id: string): Promise<Task> => {
    await jsonRpcCall('tasks:archive', { taskId: id })
    // Return a synthesized task with archived_at set so optimistic updates
    // (useTasksData mapState) match the sidecar's post-write state.
    return synthTask({ id, title: '', status: '', archived_at: Date.now() }, '', 0)
  },
  archiveTasks: async (ids: string[]): Promise<void> => {
    if (!ids || ids.length === 0) return
    await jsonRpcCall('tasks:archive-many', { taskIds: ids })
  },
  unarchiveTask: async (id: string): Promise<Task> => {
    await jsonRpcCall('tasks:unarchive', { taskId: id })
    return synthTask({ id, title: '', status: '', archived_at: null }, '', 0)
  },
  getArchivedTasks: async (): Promise<Task[]> => {
    const { tasks } = await jsonRpcCall<{
      tasks: {
        id: string
        project_id: string
        title: string
        status: string
        priority: number
        due_date: string | null
        archived_at: number | null
      }[]
    }>('tasklist:list-all', {})
    return tasks
      .filter((t) => t.archived_at !== null)
      .map((t, idx) => synthTask(t, t.project_id, idx))
  },
  reorderTasks: async (_taskIds: string[]): Promise<void> => {},
}
