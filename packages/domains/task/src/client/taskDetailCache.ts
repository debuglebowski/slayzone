import { createSuspenseCache } from '@slayzone/suspense'
import { hubAllows } from '@slayzone/transport/client'
import { getTrpcClient, getHubClient, type TaskTrpcClient } from './trpc'
import type { Task } from '@slayzone/task-contracts'
import type { Tag } from '@slayzone/tags/shared'
import { placementOn, workComputerId, type Project } from '@slayzone/projects-contracts'
import type { PanelVisibility, PanelSizes } from '@slayzone/task-contracts'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import { normalizeOverrides } from './usePanelSizes'
import { firstRealBrowserUrl } from '../shared/browser-tabs'

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
 * How long the project-path probe may take before it counts as unanswered. The
 * probe routes to the task's computer, and the hub's own deadline for that hop
 * (30s) is longer than this whole load's — so a busy or unresponsive computer
 * used to hold every task tab until the load timed out. Unanswered = "not known
 * to be missing", same as unreachable; TaskDetailPage re-probes on mount.
 */
export const PATH_PROBE_TIMEOUT_MS = 5_000

/**
 * Does the project's directory exist on the machine that owns it?
 *
 * Routed to the task's computer, not to whichever hub answered the rest of this
 * load. The old `app.files.pathExists` probed the HUB's disk, so a task whose
 * workspace lives on a computer opened with `projectPathMissing: true` and the
 * panel rendered "No repository path configured" for a path that was fine.
 *
 * A computer we cannot reach is NOT missing: `reachable: false` means the question
 * went unanswered, and claiming the path is gone would be a guess. Any throw — or
 * no answer within PATH_PROBE_TIMEOUT_MS — is read the same way: this runs inside
 * the Suspense load, and an unreachable computer must not take the whole Task
 * Detail page down with it.
 */
async function checkProjectPathMissing(
  client: TaskTrpcClient,
  taskId: string,
  path: string
): Promise<boolean> {
  const probe = async (): Promise<boolean> => {
    if (!(await hubAllows(client, 'workspace.pathExists'))) return false
    const res = await client.workspace.pathExists.query({ taskId, path })
    return res.reachable && !res.exists
  }
  return withTimeout(
    probe(),
    PATH_PROBE_TIMEOUT_MS,
    () => new Error('path probe unanswered')
  ).catch(() => false)
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

/**
 * The task-detail load ran out of time. Not a verdict on the task: it almost
 * always means the hub was too busy to answer in time, so the task pane retries
 * these on its own (see TabPanes' error boundary) rather than parking the tab on
 * a dead-end error screen.
 */
export class TaskDetailTimeoutError extends Error {
  readonly taskId: string
  constructor(taskId: string, ms: number) {
    super(`Loading task ${taskId} timed out after ${String(ms)}ms`)
    this.name = 'TaskDetailTimeoutError'
    this.taskId = taskId
  }
}

/** By name as well as class, so a copy from a second module instance still counts. */
export function isTaskDetailTimeoutError(error: unknown): error is TaskDetailTimeoutError {
  return (
    error instanceof TaskDetailTimeoutError ||
    (error instanceof Error && error.name === 'TaskDetailTimeoutError')
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms)
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
    () => new TaskDetailTimeoutError(taskId, TASK_DETAIL_FETCH_TIMEOUT_MS)
  )
}

async function fetchTaskDetailUncapped(
  taskId: string,
  hubId?: string
): Promise<TaskDetailData | null> {
  const trpc = (hubId ? getHubClient(hubId)?.client : null) ?? getTrpcClient()
  // A scoped hub returns NOT_FOUND for missing and inaccessible tasks alike.
  // Resolve that before requesting related resources for an unavailable task.
  const loadedTask = await getTaskOrNull(trpc, taskId)
  if (!loadedTask) return null

  const [loadedTags, loadedTaskTags, projects, loadedSubTasks] = await Promise.all([
    trpc.tags.list.query().catch(() => [] as Tag[]),
    trpc.tags.getForTask.query({ taskId }).catch(() => [] as Tag[]),
    trpc.projects.list.query().catch(() => [] as Project[]),
    trpc.task.getSubTasks.query({ parentId: taskId }).catch(() => [] as Task[])
  ])

  // Resolve project + path validation
  const project = projects.find((p) => p.id === loadedTask.project_id) ?? null
  // The folder on the computer this task's work runs on. One that computer already
  // reported gone is missing without asking again.
  const folder = placementOn(project, workComputerId(loadedTask, project))
  let projectPathMissing = folder?.status === 'missing'
  if (folder && (folder.status === 'ready' || folder.status === 'pending')) {
    projectPathMissing = await checkProjectPathMissing(trpc, loadedTask.id, folder.path)
  }

  // Resolve parent task
  let parentTask: Task | null = null
  if (loadedTask.parent_id) {
    parentTask = await getTaskOrNull(trpc, loadedTask.parent_id)
  }

  // Browser tabs. Fallback URLs come from sibling tasks in the SAME project
  // only — browser state must never leak across projects.
  const browserTabs =
    loadedTask.browser_tabs ??
    browserTabsAt(await siblingBrowserUrl(trpc, loadedTask.project_id, loadedTask.id))

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

async function getTaskOrNull(client: TaskTrpcClient, id: string): Promise<Task | null> {
  try {
    return await client.task.get.query({ id })
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'data' in error &&
      typeof error.data === 'object' &&
      error.data !== null &&
      'code' in error.data &&
      error.data.code === 'NOT_FOUND'
    ) {
      return null
    }
    throw error
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
 * The first real browser URL among the project's other live tasks. The hub
 * answers it directly (`task.getSiblingBrowserUrl`); a hub that predates that
 * procedure is asked for the whole project instead, the way every load used to
 * — megabytes per tab on a big project, so only as the fallback.
 */
async function siblingBrowserUrl(
  client: TaskTrpcClient,
  projectId: string,
  taskId: string
): Promise<string | null> {
  try {
    return (await client.task.getSiblingBrowserUrl.query({ projectId, excludeTaskId: taskId })).url
  } catch {
    const projectTasks = await client.task.getByProject
      .query({ projectId })
      .catch(() => [] as Task[])
    return firstSiblingBrowserUrl(taskId, projectTasks)
  }
}

/** Board-order scan of `projectTasks` (the caller restricts them to one project). */
function firstSiblingBrowserUrl(taskId: string, projectTasks: readonly Task[]): string | null {
  for (const t of projectTasks) {
    if (t.id === taskId || t.archived_at) continue
    const url = firstRealBrowserUrl(t.browser_tabs)
    if (url) return url
  }
  return null
}

/** One tab on `url`, or a blank new tab. */
function browserTabsAt(url: string | null): BrowserTabsState {
  const firstUrl = url ?? 'about:blank'
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
    browserTabs: task.browser_tabs ?? browserTabsAt(firstSiblingBrowserUrl(task.id, projectTasks))
  }
}

export const taskDetailCache = createSuspenseCache({
  taskDetail: fetchTaskDetail
})
