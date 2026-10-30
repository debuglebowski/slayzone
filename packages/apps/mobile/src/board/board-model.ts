/**
 * One project's board as plain data, through desktop's own board logic
 * (`@slayzone/tasks/board`): the project's columns (its status config), its tasks
 * filtered (`applyFilters`) and grouped by status in manual order (`groupTasksBy`), the
 * filters the app offers in desktop's terms (`FilterState`), and the tree view's nesting.
 */
import type { Task } from '@slayzone/task-contracts'
import {
  applyFilters,
  type Column,
  type ColumnConfig,
  type DueDateRange,
  defaultBoardConfig,
  defaultFilterState,
  type FilterState,
  groupTasksBy,
  resolveColumns
} from '@slayzone/tasks/board'
import type { BoardData, BoardProject, BoardTask } from '../hub-board'

/** The board's filters: a subset of desktop's `FilterState`, the same meaning. */
export interface BoardFilter {
  /** One priority (1 Urgent … 5 Someday); null = all. */
  priority: number | null
  dueDateRange: DueDateRange
  /** Tasks with at least one of these tags; empty = all. */
  tagIds: string[]
  /** Tasks in a completed or canceled column (desktop "Show completed"). */
  showDone: boolean
  /** Blocked tasks in their own Blocked column (desktop "Show blocked"). */
  showBlocked: boolean
}

export const DEFAULT_BOARD_FILTER: BoardFilter = {
  priority: defaultFilterState.priority,
  dueDateRange: defaultFilterState.dueDateRange,
  tagIds: defaultFilterState.tagIds,
  showDone: defaultBoardConfig.completedFilter === 'all',
  showBlocked: defaultBoardConfig.showBlockedColumn
}

export function filterIsActive(filter: BoardFilter): boolean {
  return (
    filter.priority !== DEFAULT_BOARD_FILTER.priority ||
    filter.dueDateRange !== DEFAULT_BOARD_FILTER.dueDateRange ||
    filter.tagIds.length > 0 ||
    filter.showDone !== DEFAULT_BOARD_FILTER.showDone ||
    filter.showBlocked !== DEFAULT_BOARD_FILTER.showBlocked
  )
}

/** The board filter in desktop's terms (its board view's config). */
export function toFilterState(filter: BoardFilter, showSubTasks = false): FilterState {
  return {
    ...defaultFilterState,
    viewMode: 'board',
    board: {
      ...defaultBoardConfig,
      completedFilter: filter.showDone ? 'all' : 'none',
      showBlockedColumn: filter.showBlocked,
      showSubTasks
    },
    priority: filter.priority,
    dueDateRange: filter.dueDateRange,
    tagIds: filter.tagIds
  }
}

/** The project's statuses, in board order (its config, else the default workflow). */
export function projectStatuses(project: BoardProject): ColumnConfig[] {
  return resolveColumns(project.columns_config)
}

/** The status before and after `status` in the project's order (a swipe's targets). */
export function neighbourStatuses(
  project: BoardProject,
  status: string
): { prev: ColumnConfig | null; next: ColumnConfig | null } {
  const statuses = projectStatuses(project)
  const i = statuses.findIndex((c) => c.id === status)
  if (i < 0) return { prev: null, next: null }
  return { prev: statuses[i - 1] ?? null, next: statuses[i + 1] ?? null }
}

/** A board column; `tasks` are the hub's rows. */
export interface BoardColumn extends Omit<Column, 'tasks'> {
  tasks: BoardTask[]
}

function filtered(
  data: BoardData,
  project: BoardProject,
  filter: BoardFilter,
  showSubTasks: boolean
): { tasks: BoardTask[]; state: FilterState } {
  const state = toFilterState(filter, showSubTasks)
  const own = (data.tasks as Task[]).filter((t) => t.project_id === project.id)
  const tags = new Map(Object.entries(data.taskTags))
  return { tasks: applyFilters(own, state, tags, project.columns_config) as BoardTask[], state }
}

/** The project's columns with its top-level tasks, filtered, in manual order. */
export function boardColumns(
  data: BoardData,
  project: BoardProject,
  filter: BoardFilter
): BoardColumn[] {
  const { tasks, state } = filtered(data, project, filter, false)
  return groupTasksBy(tasks as Task[], 'status', 'manual', project.columns_config, {
    blockedTaskIds: new Set(data.blockedTaskIds),
    viewConfig: state.board
  }) as BoardColumn[]
}

/** A row of the tree view: a task at its depth (0 = top level). */
export interface TreeNode {
  task: BoardTask
  depth: number
}

export interface TreeColumn extends Omit<BoardColumn, 'tasks'> {
  nodes: TreeNode[]
}

/**
 * The tree view: the board's columns, each top-level task followed by its subtasks
 * (depth first, in board order) whatever their own status; the filters apply to every
 * level, a subtask whose parent is filtered out is not shown.
 */
export function treeColumns(
  data: BoardData,
  project: BoardProject,
  filter: BoardFilter
): TreeColumn[] {
  const { tasks } = filtered(data, project, filter, true)
  const children = new Map<string, BoardTask[]>()
  for (const t of [...tasks].sort((a, b) => a.order - b.order)) {
    if (!t.parent_id) continue
    const list = children.get(t.parent_id) ?? []
    list.push(t)
    children.set(t.parent_id, list)
  }
  const walk = (task: BoardTask, depth: number, out: TreeNode[], seen: Set<string>): void => {
    if (seen.has(task.id)) return
    seen.add(task.id)
    out.push({ task, depth })
    for (const child of children.get(task.id) ?? []) walk(child, depth + 1, out, seen)
  }
  return boardColumns(data, project, filter).map(({ tasks: roots, ...column }) => {
    const nodes: TreeNode[] = []
    const seen = new Set<string>()
    for (const root of roots) walk(root, 0, nodes, seen)
    return { ...column, nodes }
  })
}

/** The tags a filter can pick from (the hub's tags). */
export interface BoardTag {
  id: string
  name: string
  color: string
}

export function boardTags(data: BoardData): BoardTag[] {
  return (data.tags as BoardTag[]).filter((t) => t && typeof t.id === 'string')
}
