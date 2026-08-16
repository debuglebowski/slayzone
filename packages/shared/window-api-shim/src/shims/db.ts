// cap-shell-2 — db.* shim. REAL reads/writes for four operations go through
// the priority Mojo hosts (ProjectsHost.deleteProject, TasklistHost's
// updateTaskStatus/updateTask/deleteTask, TagsHost.getTags) — those are
// genuinely wired and stay untouched below.
//
// EVERYTHING ELSE used to route through `jsonRpcCall`, which forwards to the
// hub's Unix-socket sidecar dispatch (`packages/apps/hub/src/sidecar-socket.ts`).
// That dispatch is a hardcoded 3-method switch (`sidecar.hello`/`sidecar.ping`/
// `auth:deep-link`) — every other method, including every one this file used
// to call (`projects:get-snapshot`, `tasklist:list-all`, `tasks:create`,
// `tasks:update-meta`, `tasks:archive*`, …), unconditionally rejects with
// -32601. So project/task listing, creation, and most updates were DEAD CODE:
// every call site either threw directly or threw via a tail call into
// `listTasks`/`listProjects`, which always did. Confirmed by tracing the full
// chain (Mojo `JsonRpcHost::Call` → `SidecarClient` → this socket) rather than
// assumed — see the window-api-shim dead-code cleanup that also removed 9
// wholesale-dead sibling shims (git/aiConfig/fs/assets/taskDependencies/
// feedback/tags/integrations/files) into `STUBBED_NAMESPACES`. `db` couldn't
// join them wholesale because the four Mojo-backed methods above are real.
//
// What replaces the dead ~500 lines below is a LOCAL, in-memory echo — the
// same "never throw" contract every other not-yet-wired namespace already
// gives the renderer (see stub-factory.ts), spelled out by hand here because
// this file's return shapes are real `Project`/`Task` types a generic Proxy
// stub can't synthesize. No fake persistence: a create/update returns a
// plausible row for THIS call only; every list read is empty. Widening the
// mojom surface (cap-shell-7) is the real fix, not this shim.

import type { Project, CreateProjectInput, UpdateProjectInput } from '@slayzone/projects/shared'
import type { Task, CreateTaskInput, UpdateTaskInput } from '@slayzone/task/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { TerminalMode } from '@slayzone/terminal/shared'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import { projectsRemote, tasklistRemote, tagsRemote } from '../transport/mojo'
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
  opencode: 'opencode_flags'
}

// Renderer-side cache for task fields the sidecar's `tasks` table does not
// carry yet (terminal_mode, conversation IDs, flags, isTemporary). Now that
// project/task listing has no live server counterpart at all (see file
// header), this cache is the ONLY place these fields persist across calls
// within a session — a create/update writes it, a later read (still local,
// see synthTask below) merges it back in. Cleared on deleteTask. A reload
// resets it (acceptable: e2e fixtures resetApp+reload at test boundaries;
// this was already true before this cleanup, since the cache never had a
// working server-side counterpart to reload from).
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
  opencode: 'opencode_conversation_id'
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
        ...cfg
      }
    }
    setExtras(data.id, { provider_config: nextProvider })
  }
  const flatWrites: Array<[string, string | null | undefined]> = [
    ['claude-code', data.claudeConversationId],
    ['codex', data.codexConversationId],
    ['cursor-agent', data.cursorConversationId],
    ['gemini', data.geminiConversationId],
    ['opencode', data.opencodeConversationId]
  ]
  let provMerged: Record<string, unknown> | null = null
  for (const [mode, val] of flatWrites) {
    if (val === undefined) continue
    if (!provMerged) provMerged = { ...(getExtras(data.id).provider_config ?? {}) }
    provMerged[mode] = {
      ...((provMerged as Record<string, unknown>)[mode] as object | undefined),
      conversationId: val
    }
  }
  if (provMerged) setExtras(data.id, { provider_config: provMerged })
}

const nowIso = (): string => new Date().toISOString()

// Local-echo id generator. Not a real persisted row, so no need for anything
// stronger than "distinct within this session" — mirrors the same-package
// precedent in test-invoke.ts's CSS-key generator rather than pulling in a
// UUID dependency for a value nothing durable ever reads back.
function localId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function synthProject(entry: {
  id: string
  name: string
  color: string
  path?: string | null
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
    starred: false,
    columns_config: null,
    execution_context: null,
    selected_repo: null,
    task_automation_config: null,
    lock_config: null,
    icon_letters: null,
    icon_image_path: null,
    sort_order: 0,
    created_at: nowIso(),
    updated_at: nowIso()
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
    worktree_path?: string | null
    worktree_parent_branch?: string | null
    merge_state?: string | null
    base_dir?: string | null
  },
  projectId: string,
  order: number
): Task {
  const rawArchived = entry.archived_at ?? null
  const archivedIso =
    typeof rawArchived === 'number' && rawArchived > 0
      ? new Date(rawArchived).toISOString()
      : typeof rawArchived === 'string' && rawArchived.length > 0
        ? rawArchived
        : null
  const extras = getExtras(entry.id)
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
    due_date:
      typeof entry.due_date === 'string' && entry.due_date.length > 0 ? entry.due_date : null,
    archived_at: archivedIso,
    deleted_at: null,
    // Cap-shell-migrate-all-tests: terminal fields flow through the
    // renderer-side `terminalExtras` cache defined at top of this file —
    // there is no live server row to source them from at all now (see file
    // header). Default mode is 'claude-code' to match the Electron baseline.
    terminal_mode: (extras.terminal_mode ?? 'claude-code') as Task['terminal_mode'],
    provider_config: (extras.provider_config ?? {}) as Task['provider_config'],
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
        : (extras.worktree_path ?? null),
    worktree_parent_branch:
      typeof entry.worktree_parent_branch === 'string' && entry.worktree_parent_branch.length > 0
        ? entry.worktree_parent_branch
        : null,
    base_dir:
      typeof entry.base_dir === 'string' && entry.base_dir.length > 0
        ? entry.base_dir
        : (extras.base_dir ?? null),
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
    linear_url: extras.linear_url ?? null
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
    created_at: nowIso()
  }
}

async function listTags(activeProjectId: string): Promise<Tag[]> {
  const remote = await tagsRemote()
  const { tags } = await remote.getTags()
  return tags.map((t: { id: string; name: string; color: string }) => synthTag(t, activeProjectId))
}

export const dbShim = {
  // Projects — no live server counterpart (see file header); every list is
  // empty and every create/update is a local-only echo.
  getProjects: async (): Promise<Project[]> => [],
  createProject: async (data: CreateProjectInput): Promise<Project> =>
    synthProject({
      id: localId('project'),
      name: data.name,
      color: data.color ?? '',
      path: data.path
    }),
  updateProject: async (data: UpdateProjectInput): Promise<Project> =>
    synthProject({
      id: data.id,
      name: data.name ?? '',
      color: data.color ?? '',
      path: data.path
    }),
  deleteProject: async (id: string): Promise<boolean> => {
    const remote = await projectsRemote()
    const { result } = await remote.deleteProject(id)
    return result.ok
  },
  reorderProjects: async (_projectIds: string[]): Promise<void> => {
    // TODO(cap-shell-7): ProjectsHost has no reorder yet — stub.
  },
  uploadProjectIcon: async (projectId: string, _sourcePath: string): Promise<Project> => {
    // TODO(cap-shell-6): needs files shim. Stub returns a placeholder project.
    return synthProject({ id: projectId, name: '', color: '' })
  },

  // Tasks — same story: no live listing/creation, local echo only.
  getTasks: async (): Promise<Task[]> => [],
  loadBoardData: async (): Promise<{
    tasks: Task[]
    projects: Project[]
    tags: Tag[]
    taskTags: Record<string, string[]>
    blockedTaskIds: string[]
  }> => ({
    projects: [],
    tasks: [],
    // Tags are the one part of this composite backed by a real Mojo host —
    // TagsHost.getTags is not scoped to a project on the wire, so an empty
    // activeProjectId here only affects the LABEL synthTag stamps on each row.
    tags: await listTags(''),
    taskTags: {}, // per-task tags resolved lazily via taskTags.getTagsForTask
    blockedTaskIds: []
  }),
  getTasksByProject: async (_projectId: string): Promise<Task[]> => [],
  getTask: async (_id: string): Promise<Task | null> => null,
  getSubTasks: async (_parentId: string): Promise<Task[]> => [],
  createTask: async (data: CreateTaskInput): Promise<Task> => {
    const id = localId('task')
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
    createExtras.claude_flags =
      createExt.claudeFlags ?? (await liveDefaultFlagsForMode('claude-code'))
    createExtras.codex_flags = createExt.codexFlags ?? (await liveDefaultFlagsForMode('codex'))
    createExtras.cursor_flags =
      createExt.cursorFlags ?? (await liveDefaultFlagsForMode('cursor-agent'))
    createExtras.gemini_flags = createExt.geminiFlags ?? (await liveDefaultFlagsForMode('gemini'))
    createExtras.opencode_flags =
      createExt.opencodeFlags ?? (await liveDefaultFlagsForMode('opencode'))
    if (createExt.terminalMode !== undefined) createExtras.terminal_mode = createExt.terminalMode
    if (createExt.isTemporary !== undefined) createExtras.is_temporary = createExt.isTemporary
    setExtras(id, createExtras)
    return synthTask(
      {
        id,
        title: data.title ?? '',
        status: data.status ?? 'todo',
        priority: data.priority ?? 3,
        due_date: data.dueDate ?? null
      },
      data.projectId,
      0
    )
  },
  updateTask: async (data: UpdateTaskInput): Promise<Task> => {
    // cap-migrate-all-tests (terminal-core batch) — terminal-related fields
    // (terminal_mode, conversation IDs, flags, is_temporary) land in the
    // renderer-side `terminalExtras` cache, which `synthTask` below reads
    // back — this cache IS the storage now, not a pre-read before a network
    // round-trip (there is none left for these fields).
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
    // badge without an external_links table in the sidecar.
    const linearLike = data as UpdateTaskInput & { linearUrl?: string | null }
    if (linearLike.linearUrl !== undefined) terminalPatch.linear_url = linearLike.linearUrl
    if (Object.keys(terminalPatch).length > 0) setExtras(data.id, terminalPatch)
    syncProviderAndFlatConversationIds(data)
    // Mode-switch invariant: on terminalMode changes the renderer drops all
    // other conversation IDs (Electron's main handler mirrors this).
    if (data.terminalMode !== undefined) {
      const explicitFlat: Record<string, boolean> = {
        'claude-code': data.claudeConversationId !== undefined,
        codex: data.codexConversationId !== undefined,
        'cursor-agent': data.cursorConversationId !== undefined,
        gemini: data.geminiConversationId !== undefined,
        opencode: data.opencodeConversationId !== undefined
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
              conversationId: null
            }
          }
        })
      }
      // Reset per-mode flag fields to their built-in defaults on any mode
      // switch. Matches the Electron "switching back restores the mode's
      // default flags" behavior. Skips flags the caller explicitly set in
      // this same update so a synchronous flag-update-with-mode-switch wins.
      const explicitFlags: Record<string, boolean> = {
        'claude-code': data.claudeFlags !== undefined,
        codex: data.codexFlags !== undefined,
        'cursor-agent': data.cursorFlags !== undefined,
        gemini: data.geminiFlags !== undefined,
        opencode: data.opencodeFlags !== undefined
      }
      for (const mode of Object.keys(explicitFlags)) {
        if (explicitFlags[mode]) continue
        const flat = MODE_TO_FLAT_FLAGS[mode]
        if (!flat) continue
        setExtras(data.id, { [flat]: defaultFlagsForMode(mode) } as TerminalRowExtras)
      }
    }

    // The one part of this method with a REAL server-side effect.
    const remote = await tasklistRemote()
    if (data.status !== undefined) {
      await remote.updateTaskStatus(data.id, data.status)
    }
    if (data.title !== undefined || data.description !== undefined) {
      await remote.updateTask(data.id, data.title ?? '', data.description ?? '')
    }

    // cap-migrate-all-tests (git batch): sidecar-side auto-clear of every
    // provider's conversationId on a worktree_path/base_dir/projectId move
    // (matches Electron main handlers.ts:383-397) — mirrored here against
    // the LOCAL cache, since that cache is the only place these fields live.
    const extended = data as UpdateTaskInput & {
      worktreePath?: string | null
      worktreeParentBranch?: string | null
      mergeState?: string | null
      baseDir?: string | null
      projectId?: string
      providerConfig?: Record<string, unknown> | null
    }
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
      setExtras(data.id, {
        claude_conversation_id: null,
        codex_conversation_id: null,
        cursor_conversation_id: null,
        gemini_conversation_id: null,
        opencode_conversation_id: null
      })
    }

    // Local echo of the row as updated — synthTask merges the extras cache
    // (just written above) back in, so terminal-field round-trips still work
    // within a session even with no server-side task table behind this.
    return synthTask(
      {
        id: data.id,
        title: data.title ?? '',
        status: data.status ?? '',
        priority: data.priority,
        due_date: data.dueDate,
        worktree_path: extended.worktreePath,
        worktree_parent_branch: extended.worktreeParentBranch,
        merge_state: extended.mergeState,
        base_dir: extended.baseDir
      },
      extended.projectId ?? '',
      0
    )
  },
  deleteTask: async (id: string): Promise<boolean> => {
    const remote = await tasklistRemote()
    const { result } = await remote.deleteTask(id)
    terminalExtras.delete(id)
    return result.ok
  },
  restoreTask: async (id: string): Promise<Task> => synthTask({ id, title: '', status: '' }, '', 0),
  archiveTask: async (id: string): Promise<Task> =>
    synthTask({ id, title: '', status: '', archived_at: Date.now() }, '', 0),
  archiveTasks: async (_ids: string[]): Promise<void> => {
    // Local-echo only — see file header. No-op beyond the type contract.
  },
  unarchiveTask: async (id: string): Promise<Task> =>
    synthTask({ id, title: '', status: '', archived_at: null }, '', 0),
  getArchivedTasks: async (): Promise<Task[]> => [],
  reorderTasks: async (_taskIds: string[]): Promise<void> => {
    // TODO(cap-shell-7): TasklistHost has no reorder yet — stub, same gap as
    // `reorderProjects` above. Board DnD reorders optimistically in the
    // renderer; the order just doesn't survive a reload under the fork.
  }
}
