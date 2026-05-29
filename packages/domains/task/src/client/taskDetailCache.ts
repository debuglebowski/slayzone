import { createSuspenseCache } from '@slayzone/suspense'
import type { Task } from '@slayzone/task/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Project } from '@slayzone/projects/shared'
import type { PanelVisibility } from '@slayzone/task/shared'
import type { BrowserTabsState } from '@slayzone/task-browser/shared'

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
  browserTabs: BrowserTabsState
}

export interface TaskDetailSnapshotInput {
  task: Task
  tasks: Task[]
  projects: Project[]
  tags: Tag[]
  taskTagIds: string[]
  projectPathMissing?: boolean
}

async function checkProjectPathExists(path: string): Promise<boolean> {
  const pathExists = window.api.files?.pathExists
  if (typeof pathExists === 'function') return pathExists(path)
  return true
}

export { fetchTaskDetail }

function getPanelVisibility(task: Task): PanelVisibility {
  return {
    ...DEFAULT_PANEL_VISIBILITY,
    ...(task.panel_visibility ?? {}),
    ...(task.is_temporary ? { settings: false } : {})
  }
}

function getBrowserTabs(task: Task, tasks: Task[]): BrowserTabsState {
  if (task.browser_tabs) return task.browser_tabs
  let firstUrl = 'about:blank'
  for (const t of tasks) {
    if (t.id === task.id) continue
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

export function buildTaskDetailDataFromSnapshot({
  task,
  tasks,
  projects,
  tags,
  taskTagIds,
  projectPathMissing = false
}: TaskDetailSnapshotInput): TaskDetailData {
  const project = projects.find((p) => p.id === task.project_id) ?? null
  return {
    task,
    project,
    tags: tags.filter((t) => t.project_id === task.project_id),
    taskTagIds,
    subTasks: tasks.filter((t) => t.parent_id === task.id),
    parentTask: task.parent_id ? (tasks.find((t) => t.id === task.parent_id) ?? null) : null,
    projectPathMissing,
    panelVisibility: getPanelVisibility(task),
    browserTabs: getBrowserTabs(task, tasks)
  }
}

async function fetchTaskDetail(taskId: string): Promise<TaskDetailData | null> {
  // Task fetch is critical — let it throw. Secondary data uses defaults on failure.
  const [loadedTask, loadedTags, loadedTaskTags, projects, loadedSubTasks] = await Promise.all([
    window.api.db.getTask(taskId),
    window.api.tags.getTags().catch(() => [] as Tag[]),
    window.api.taskTags.getTagsForTask(taskId).catch(() => [] as Tag[]),
    window.api.db.getProjects().catch(() => [] as Project[]),
    window.api.db.getSubTasks(taskId).catch(() => [] as Task[])
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
    parentTask = await window.api.db.getTask(loadedTask.parent_id)
  }

  // Resolve panel visibility
  const panelVisibility = getPanelVisibility(loadedTask)

  // Resolve browser tabs (including fallback to first URL from other tasks)
  let browserTabs: BrowserTabsState
  if (loadedTask.browser_tabs) {
    browserTabs = loadedTask.browser_tabs
  } else {
    const allTasks = await window.api.db.getTasks()
    browserTabs = getBrowserTabs(loadedTask, allTasks)
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
    browserTabs
  }
}

export const taskDetailCache = createSuspenseCache({
  taskDetail: fetchTaskDetail
})
