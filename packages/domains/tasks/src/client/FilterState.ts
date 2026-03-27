export type GroupKey = 'none' | 'active' | 'status' | 'priority' | 'due_date'
export type DueDateRange = 'all' | 'overdue' | 'today' | 'week' | 'later'
export type SortKey = 'manual' | 'priority' | 'due_date' | 'title' | 'created'
export type CompletedFilter = 'none' | 'all'
export type ViewMode = 'board' | 'list'

export interface CardProperties {
  priority: boolean
  dueDate: boolean
  terminal: boolean
  linear: boolean
  blocked: boolean
  subtasks: boolean
  merge: boolean
  tags: boolean
}

/** Per-view-mode display settings */
export interface ViewConfig {
  groupBy: GroupKey
  sortBy: SortKey
  showEmptyColumns: boolean
  completedFilter: CompletedFilter
  showArchived: boolean
  showSubTasks: boolean
}

export interface FilterState {
  viewMode: ViewMode
  board: ViewConfig
  list: ViewConfig
  // Shared across views
  priority: number | null // null = all priorities
  dueDateRange: DueDateRange
  tagIds: string[] // selected tag IDs
  cardProperties: CardProperties
}

export const defaultCardProperties: CardProperties = {
  priority: true,
  dueDate: true,
  terminal: true,
  linear: true,
  blocked: true,
  subtasks: true,
  merge: true,
  tags: true
}

export const defaultBoardConfig: ViewConfig = {
  groupBy: 'status',
  sortBy: 'manual',
  showEmptyColumns: true,
  completedFilter: 'all',
  showArchived: false,
  showSubTasks: false
}

export const defaultListConfig: ViewConfig = {
  groupBy: 'status',
  sortBy: 'manual',
  showEmptyColumns: true,
  completedFilter: 'all',
  showArchived: false,
  showSubTasks: false
}

export const defaultFilterState: FilterState = {
  viewMode: 'board',
  board: defaultBoardConfig,
  list: defaultListConfig,
  priority: null,
  dueDateRange: 'all',
  tagIds: [],
  cardProperties: defaultCardProperties
}

/** Get the active view's config */
export function getViewConfig(filter: FilterState): ViewConfig {
  return filter[filter.viewMode]
}
