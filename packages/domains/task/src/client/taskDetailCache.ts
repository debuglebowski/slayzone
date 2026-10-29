import { createSuspenseCache } from '@slayzone/suspense'
import { getTrpcClient, getHubClient, type TaskTrpcClient } from './trpc'
import type { Task } from '@slayzone/task-contracts'
import type { Tag } from '@slayzone/tags/shared'
import type { Project } from '@slayzone/projects-contracts'
import type { PanelVisibility, PanelSizes } from '@slayzone/task-contracts'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import { normalizeOverrides } from './usePanelSizes'

const DEFAULT_PANEL_VISIBILITY: PanelVisibility = {
  terminal: true,
  browser: false,
  diff: false,
  settings: true,
  editor: false,
  artifacts: false,
  processes: false
}

export interface TaskDetailData {
  task: Task
  project: Project | null
  tags: Tag[]
  taskTagIds: string[]
  /** The task's tags as fetched (seeds the tab's tag query — no refetch on mount). */
  taskTags?: Tag[]
  subTasks: Task[]
  parentTask: Task | null
  projectPathMissing: boolean
  panelVisibility: PanelVisibility
  panelSizes: PanelSizes
  browserTabs: BrowserTabsState
}

/**
 * Does the project's directory exist on the machine that owns it?
 *
 * Routed to the task's computer, not to whichever hub answered the rest of this
 * load. The old `app.files.pathExists` probed the HUB's disk, so a task whose
 * workspace lives on a computer opened with `projectPathMissing: true` and the
 * panel rendered "No repository path configured" for a path that was fine.
 *
 * A computer we cannot reach is NOT missing: `reachable: false` means the question
 * went unanswered, and claiming the path is gone would be a guess. Any throw is
 * read the same way — this runs inside the Suspense load, and an unreachable
 * computer must not take the whole Task Detail page down with it.
 */
async function checkProjectPathMissing(
  client: TaskTrpcClient,
  taskId: string,
  path: string
): Promise<boolean> {
  try {
    const res = await client.workspace.pathExists.query({ taskId, path })
    return res.reachable && !res.exists
  } catch {
    return false
  }
}

/**
 * How long a task-detail fetch may run before it is treated as hung and
 * rejected. Nothing below this bounds a stall AFTER the hub socket is already
 * open (a locked DB row, an unresponsive routed computer, ...) — without it,
 * `fetchTaskDetail`'s promise (and therefore the Suspense cache entry backing
 * the task tab) can sit unsettled forever, which is what leaves a task tab
 * permanently showing the `TaskShell` loading skeleton with no error and no
 * retry. Well above `HUB_CONNECT_DEADLINE_MS` (15s, connectDeadlineLink) so the
 * ordinary "hub not connected yet" case still resolves through its own path
 * first — this is the backstop for everything that path doesn't cover.
 */
export const TASK_DETAIL_FETCH_TIMEOUT_MS = 20_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Multi-hub: resolve the tRPC client for the hub that owns this task. `hubId`
 * comes from the enclosing HubScope (see TaskDetailDataLoader). Absent / default
 * / unknown hub → the boot singleton (default hub), so single-hub is
 * byte-identical. The cache keys this fetcher by (taskId, hubId), so the same
 * task id on two hubs occupies distinct cache slots.
 */
export async function fetchTaskDetail(
  taskId: string,
  hubId?: string
): Promise<TaskDetailData | null> {
  return withTimeout(
    fetchTaskDetailUncapped(taskId, hubId),
    TASK_DETAIL_FETCH_TIMEOUT_MS,
    `Loading task ${taskId} timed out after ${String(TASK_DETAIL_FETCH_TIMEOUT_MS)}ms`
  )
}

async function fetchTaskDetailUncapped(
  taskId: string,
  hubId?: string
): Promise<TaskDetailData | null> {
  const trpc = (hubId ? getHubClient(hubId)?.client : null) ?? getTrpcClient()
  // Task fetch is critical — let it throw. Secondary data uses defaults on failure.
  const [loadedTask, loadedTags, loadedTaskTags, projects, loadedSubTasks] = await Promise.all([
    trpc.task.get.query({ id: taskId }),
    trpc.tags.list.query().catch(() => [] as Tag[]),
    trpc.tags.getForTask.query({ taskId }).catch(() => [] as Tag[]),
    trpc.projects.list.query().catch(() => [] as Project[]),
    trpc.task.getSubTasks.query({ parentId: taskId }).catch(() => [] as Task[])
  ])

  if (!loadedTask) return null

  // Resolve project + path validation
  const project = projects.find((p) => p.id === loadedTask.project_id) ?? null
  let projectPathMissing = false
  if (project?.path) {
    projectPathMissing = await checkProjectPathMissing(trpc, loadedTask.id, project.path)
  }

  // Resolve parent task
  let parentTask: Task | null = null
  if (loadedTask.parent_id) {
    parentTask = await trpc.task.get.query({ id: loadedTask.parent_id })
  }

  // Browser tabs. Fallback URLs come from sibling tasks in the SAME project
  // only — browser state must never leak across projects.
  const browserTabs = loadedTask.browser_tabs
    ? loadedTask.browser_tabs
    : resolveBrowserTabs(
        loadedTask,
        await trpc.task.getByProject
          .query({ projectId: loadedTask.project_id })
          .catch(() => [] as Task[])
      )

  return {
    task: loadedTask,
    project,
    tags: loadedTags.filter((t) => t.project_id === loadedTask.project_id),
    taskTagIds: loadedTaskTags.map((t) => t.id),
    taskTags: loadedTaskTags,
    subTasks: loadedSubTasks,
    parentTask,
    projectPathMissing,
    panelVisibility: resolvePanelVisibility(loadedTask),
    // Per-task, size-only overrides; defaults come from the global layout config
    // at resolve time — do NOT seed defaults here, or they'd masquerade as
    // per-task overrides.
    panelSizes: normalizeOverrides(loadedTask.panel_sizes),
    browserTabs
  }
}

function resolvePanelVisibility(task: Task): PanelVisibility {
  return {
    ...DEFAULT_PANEL_VISIBILITY,
    ...(task.panel_visibility ?? {}),
    ...(task.is_temporary ? { settings: false } : {})
  }
}

/**
 * The task's saved browser tabs, else one tab on the first real URL found among
 * `projectTasks` — which the caller must restrict to the task's own project.
 */
function resolveBrowserTabs(task: Task, projectTasks: readonly Task[]): BrowserTabsState {
  if (task.browser_tabs) return task.browser_tabs
  let firstUrl = 'about:blank'
  for (const t of projectTasks) {
    if (t.id === task.id || t.archived_at) continue
    const url = t.browser_tabs?.tabs?.find((tab) => tab.url && tab.url !== 'about:blank')?.url
    if (url) {
      firstUrl = url
      break
    }
  }
  return {
    tabs: [
      { id: 'default', url: firstUrl, title: firstUrl === 'about:blank' ? 'New Tab' : firstUrl }
    ],
    activeTabId: 'default'
  }
}

export interface TaskDetailSnapshotInput {
  /** Every task the caller holds (any project, any hub) — filtered here. */
  tasks: readonly Task[]
  projects: readonly Project[]
  /** Every tag the caller holds — filtered to the task's project here. */
  tags: readonly Tag[]
  taskTagIds: readonly string[]
  /**
   * The caller's latest answer for this task's project, or `false` when it has
   * none — the same "not known to be missing" `fetchTaskDetail` uses for an
   * unreachable computer. TaskDetailPage re-probes on mount either way.
   */
  projectPathMissing: boolean
}

/**
 * `fetchTaskDetail`'s result, built from board state the renderer already holds
 * (same rows: `task.loadBoardData` selects what `task.get` does). Feed it to
 * `taskDetailCache.prime` so opening a known task renders at once instead of
 * suspending on five hub round-trips. Returns null when `taskId` is not in `tasks`.
 *
 * `taskTags` is left out on purpose: without it the tab's tag query fetches
 * fresh (it never refetches once seeded), while `taskTagIds` fills the gap.
 */
export function buildTaskDetailSnapshot(
  taskId: string,
  input: TaskDetailSnapshotInput
): TaskDetailData | null {
  const task = input.tasks.find((t) => t.id === taskId)
  if (!task) return null
  const projectTasks = input.tasks.filter((t) => t.project_id === task.project_id)
  return {
    task,
    project: input.projects.find((p) => p.id === task.project_id) ?? null,
    tags: input.tags.filter((t) => t.project_id === task.project_id),
    taskTagIds: [...input.taskTagIds],
    subTasks: projectTasks.filter((t) => t.parent_id === task.id && !t.archived_at),
    parentTask: task.parent_id ? (projectTasks.find((t) => t.id === task.parent_id) ?? null) : null,
    projectPathMissing: input.projectPathMissing,
    panelVisibility: resolvePanelVisibility(task),
    panelSizes: normalizeOverrides(task.panel_sizes),
    browserTabs: resolveBrowserTabs(task, projectTasks)
  }
}

export const taskDetailCache = createSuspenseCache({
  taskDetail: fetchTaskDetail
})
