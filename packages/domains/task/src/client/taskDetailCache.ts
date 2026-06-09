import { createSuspenseCache } from '@slayzone/suspense'
import { getTrpcClient } from '@slayzone/transport/client'
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

async function checkProjectPathExists(path: string): Promise<boolean> {
  return getTrpcClient().app.files.pathExists.query({ filePath: path })
}

export { fetchTaskDetail }

async function fetchTaskDetail(taskId: string): Promise<TaskDetailData | null> {
  const trpc = getTrpcClient()
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
    projectPathMissing = !(await checkProjectPathExists(project.path))
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
