import { createSuspenseCache } from '@slayzone/suspense'
import type { Task } from '@slayzone/task/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Project } from '@slayzone/projects/shared'
import type { PanelVisibility } from '@slayzone/task/shared'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'
import { getTrpcVanillaClient } from '@slayzone/transport/client'

const DEFAULT_PANEL_VISIBILITY: PanelVisibility = {
  terminal: true, browser: false, diff: false, settings: true, editor: false, artifacts: false, processes: false,
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
  browserTabs: BrowserTabsState
}

async function checkProjectPathExists(path: string): Promise<boolean> {
  return getTrpcVanillaClient().app.files.pathExists.query({ filePath: path })
}

export { fetchTaskDetail }

async function fetchTaskDetail(taskId: string): Promise<TaskDetailData | null> {
  // Task fetch is critical — let it throw. Secondary data uses defaults on failure.
  const [loadedTask, loadedTags, loadedTaskTags, projects, loadedSubTasks] = await Promise.all([
    getTrpcVanillaClient().task.get.query({ id: taskId }),
    getTrpcVanillaClient().tags.list.query().catch(() => [] as Tag[]),
    getTrpcVanillaClient().tags.getForTask.query({ taskId }).catch(() => [] as Tag[]),
    getTrpcVanillaClient().projects.list.query().catch(() => [] as Project[]),
    getTrpcVanillaClient().task.getSubTasks.query({ parentId: taskId }).catch(() => [] as Task[]),
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
    parentTask = await getTrpcVanillaClient().task.get.query({ id: loadedTask.parent_id })
  }

  // Resolve panel visibility
  const panelVisibility: PanelVisibility = {
    ...DEFAULT_PANEL_VISIBILITY,
    ...(loadedTask.panel_visibility ?? {}),
    ...(loadedTask.is_temporary ? { settings: false } : {}),
  }

  // Resolve browser tabs (including fallback to first URL from other tasks)
  let browserTabs: BrowserTabsState
  if (loadedTask.browser_tabs) {
    browserTabs = loadedTask.browser_tabs
  } else {
    const allTasks = await getTrpcVanillaClient().task.getAll.query()
    let firstUrl = 'about:blank'
    for (const t of allTasks) {
      if (t.id === loadedTask.id) continue
      const url = t.browser_tabs?.tabs?.find((tab) => tab.url && tab.url !== 'about:blank')?.url
      if (url) {
        firstUrl = url
        break
      }
    }
    browserTabs = {
      tabs: [{ id: 'default', url: firstUrl, title: firstUrl === 'about:blank' ? 'New Tab' : firstUrl }],
      activeTabId: 'default',
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
    browserTabs,
  }
}

export const taskDetailCache = createSuspenseCache({
  taskDetail: fetchTaskDetail,
})
