import { createSuspenseCache } from '@slayzone/suspense'
import { getTrpcClient, getHubClient, type TrpcVanillaClient } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Project } from '@slayzone/projects/shared'
import type { PanelVisibility, PanelSizes } from '@slayzone/task/shared'
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
  client: TrpcVanillaClient,
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

export { fetchTaskDetail }

/**
 * Multi-hub: resolve the tRPC client for the hub that owns this task. `hubId`
 * comes from the enclosing HubScope (see TaskDetailDataLoader). Absent / default
 * / unknown hub → the boot singleton (default hub), so single-hub is
 * byte-identical. The cache keys this fetcher by (taskId, hubId), so the same
 * task id on two hubs occupies distinct cache slots.
 */
async function fetchTaskDetail(taskId: string, hubId?: string): Promise<TaskDetailData | null> {
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

  // Resolve panel visibility
  const panelVisibility: PanelVisibility = {
    ...DEFAULT_PANEL_VISIBILITY,
    ...(loadedTask.panel_visibility ?? {}),
    ...(loadedTask.is_temporary ? { settings: false } : {})
  }

  // Resolve panel size overrides (per-task, size-only; defaults come from the
  // global layout config at resolve time — do NOT seed defaults here, or they'd
  // masquerade as per-task overrides).
  const panelSizes: PanelSizes = normalizeOverrides(loadedTask.panel_sizes)

  // Resolve browser tabs. Fallback URLs come from sibling tasks in the SAME
  // project only — browser state must never leak across projects.
  let browserTabs: BrowserTabsState
  if (loadedTask.browser_tabs) {
    browserTabs = loadedTask.browser_tabs
  } else {
    const projectTasks = await trpc.task.getByProject
      .query({ projectId: loadedTask.project_id })
      .catch(() => [] as Task[])
    let firstUrl = 'about:blank'
    for (const t of projectTasks) {
      if (t.id === loadedTask.id) continue
      const url = t.browser_tabs?.tabs?.find((tab) => tab.url && tab.url !== 'about:blank')?.url
      if (url) {
        firstUrl = url
        break
      }
    }
    browserTabs = {
      tabs: [
        { id: 'default', url: firstUrl, title: firstUrl === 'about:blank' ? 'New Tab' : firstUrl }
      ],
      activeTabId: 'default'
    }
  }

  return {
    task: loadedTask,
    project,
    tags: loadedTags.filter((t) => t.project_id === loadedTask.project_id),
    taskTagIds: loadedTaskTags.map((t) => t.id),
    subTasks: loadedSubTasks,
    parentTask,
    projectPathMissing,
    panelVisibility,
    panelSizes,
    browserTabs
  }
}

export const taskDetailCache = createSuspenseCache({
  taskDetail: fetchTaskDetail
})
