/**
 * One project's board as plain data, through desktop's own board logic
 * (`@slayzone/tasks/board`): its tasks filtered (`applyFilters`), grouped (`groupTasksBy`:
 * the project's status columns, priority, due date; the list also "No groups" and
 * "Activity", `splitActiveInactiveColumns`) and sorted (`sortTasks`) as desktop's Display
 * menu says, the filters and Display options in desktop's terms (`FilterState`), and the
 * tree view's nesting.
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
  type GroupKey,
  groupTasksBy,
  resolveColumns,
  type SortKey,
  splitActiveInactiveColumns
} from '@slayzone/tasks/board'
import type { BoardData, BoardProject, BoardTask } from '../hub-board'
import type { BoardView } from './board-prefs'

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
  /** Columns without (shown) tasks too (desktop "Show empty columns"). */
  showEmpty: boolean
  /** Desktop "Grouping": the board's columns (the list's sections). "none" and "active"
   * are the list's only; the board and the tree use status for them (`displayGroup`). */
  groupBy: GroupKey
  /** Desktop "Ordering", within each column. */
  sortBy: SortKey
  /** Archived tasks too (desktop "Show archived"). */
  showArchived: boolean
  /** Sub-tasks as cards of their own, in their own status column (desktop "Show sub-tasks"). */
  showSubTasks: boolean
}

export const DEFAULT_BOARD_FILTER: BoardFilter = {
  priority: defaultFilterState.priority,
  dueDateRange: defaultFilterState.dueDateRange,
  tagIds: defaultFilterState.tagIds,
  showDone: defaultBoardConfig.completedFilter === 'all',
  showBlocked: defaultBoardConfig.showBlockedColumn,
  showEmpty: defaultBoardConfig.showEmptyColumns,
  groupBy: defaultBoardConfig.groupBy,
  sortBy: defaultBoardConfig.sortBy,
  showArchived: defaultBoardConfig.showArchived,
  showSubTasks: defaultBoardConfig.showSubTasks
}

/** Desktop's grouping options: the board's, and the list's (which adds two). */
export const BOARD_GROUPS: readonly GroupKey[] = ['status', 'priority', 'due_date']
export const LIST_GROUPS: readonly GroupKey[] = ['none', 'active', ...BOARD_GROUPS]
export const GROUP_LABELS: Readonly<Record<GroupKey, string>> = {
  none: 'No groups',
  active: 'Activity',
  status: 'Status',
  priority: 'Priority',
  due_date: 'Due date'
}
export const SORTS: readonly SortKey[] = ['manual', 'priority', 'due_date', 'title', 'created']
export const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  manual: 'Manual',
  priority: 'Priority',
  due_date: 'Due date',
  title: 'Title',
  created: 'Newest'
}

/** The grouping a view shows: the list any, the board and the tree only the board's. */
export function displayGroup(view: BoardView, groupBy: GroupKey): GroupKey {
  if (view === 'list') return groupBy
  return BOARD_GROUPS.includes(groupBy) ? groupBy : 'status'
}

export function filterIsActive(filter: BoardFilter): boolean {
  return (
    filter.priority !== DEFAULT_BOARD_FILTER.priority ||
    filter.dueDateRange !== DEFAULT_BOARD_FILTER.dueDateRange ||
    filter.tagIds.length > 0 ||
    filter.showDone !== DEFAULT_BOARD_FILTER.showDone ||
    filter.showBlocked !== DEFAULT_BOARD_FILTER.showBlocked ||
    filter.showEmpty !== DEFAULT_BOARD_FILTER.showEmpty ||
    filter.groupBy !== DEFAULT_BOARD_FILTER.groupBy ||
    filter.sortBy !== DEFAULT_BOARD_FILTER.sortBy ||
    filter.showArchived !== DEFAULT_BOARD_FILTER.showArchived ||
    filter.showSubTasks !== DEFAULT_BOARD_FILTER.showSubTasks
  )
}

/** The filter hides tasks by what they are (priority, due date, tags) — the Filter sheet's
 * part, not Display's: what the ⋯ dot and "Clear filters" are about. */
export function filterNarrows(filter: BoardFilter): boolean {
  return (
    filter.priority !== DEFAULT_BOARD_FILTER.priority ||
    filter.dueDateRange !== DEFAULT_BOARD_FILTER.dueDateRange ||
    filter.tagIds.length > 0
  )
}

/** `filter` without its narrowing (priority, due date, tags); Display's options stay. */
export function clearNarrowing(filter: BoardFilter): BoardFilter {
  return {
    ...filter,
    priority: DEFAULT_BOARD_FILTER.priority,
    dueDateRange: DEFAULT_BOARD_FILTER.dueDateRange,
    tagIds: DEFAULT_BOARD_FILTER.tagIds
  }
}

/** `filter` with Display's options back at their defaults; the narrowing stays. */
export function resetDisplay(filter: BoardFilter): BoardFilter {
  return {
    ...filter,
    showDone: DEFAULT_BOARD_FILTER.showDone,
    showBlocked: DEFAULT_BOARD_FILTER.showBlocked,
    showEmpty: DEFAULT_BOARD_FILTER.showEmpty,
    groupBy: DEFAULT_BOARD_FILTER.groupBy,
    sortBy: DEFAULT_BOARD_FILTER.sortBy,
    showArchived: DEFAULT_BOARD_FILTER.showArchived,
    showSubTasks: DEFAULT_BOARD_FILTER.showSubTasks
  }
}

/** The board filter in desktop's terms (its board view's config); `showSubTasks`
 * overrides the filter's (the tree reads every level). */
export function toFilterState(
  filter: BoardFilter,
  showSubTasks = filter.showSubTasks
): FilterState {
  return {
    ...defaultFilterState,
    viewMode: 'board',
    board: {
      ...defaultBoardConfig,
      groupBy: filter.groupBy,
      sortBy: filter.sortBy,
      completedFilter: filter.showDone ? 'all' : 'none',
      showBlockedColumn: filter.showBlocked,
      showEmptyColumns: filter.showEmpty,
      showArchived: filter.showArchived,
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

/** What the board's columns depend on beyond the filter. */
export interface ColumnsOptions {
  /** The view showing them (default: the board). */
  view?: BoardView
  /** Tasks with an alive agent session (the list's "Activity" grouping). */
  activeTaskIds?: ReadonlySet<string>
}

/** The project's columns (or groups) with its tasks, filtered, sorted and grouped as the
 * Display options say; empty columns only with "show empty columns" (desktop's
 * `KanbanBoard` / `KanbanListView`). */
export function boardColumns(
  data: BoardData,
  project: BoardProject,
  filter: BoardFilter,
  { view = 'kanban', activeTaskIds = new Set() }: ColumnsOptions = {},
  showSubTasks = filter.showSubTasks
): BoardColumn[] {
  const { tasks, state } = filtered(data, project, filter, showSubTasks)
  const groupBy = displayGroup(view, filter.groupBy)
  let columns = groupTasksBy(tasks as Task[], groupBy, filter.sortBy, project.columns_config, {
    blockedTaskIds: new Set(data.blockedTaskIds),
    viewConfig: state.board
  }) as BoardColumn[]
  if (groupBy === 'active' && columns.length === 1) {
    columns = splitActiveInactiveColumns(
      columns[0].tasks as Task[],
      activeTaskIds,
      filter.showEmpty
    ) as BoardColumn[]
  }
  return filter.showEmpty ? columns : columns.filter((c) => c.tasks.length > 0)
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
  filter: BoardFilter,
  options: ColumnsOptions = {}
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
  const top = boardColumns(data, project, filter, { ...options, view: 'tree' }, false)
  return top.map(({ tasks: roots, ...column }) => {
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
