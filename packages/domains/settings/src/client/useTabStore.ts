import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { shallow } from 'zustand/shallow'
import type { TaskStatus } from '@slayzone/task/shared'

export type ActiveView = 'tabs' | 'leaderboard' | 'usage-analytics' | 'context'

export type TreeGroupBy = 'none' | 'status' | 'priority'
export type TreeOrderBy =
  | 'manual'
  | 'priority'
  | 'due_date'
  | 'title'
  | 'created'
  | 'last_interaction'
export type TreeOrderDir = 'asc' | 'desc'

export type TaskHeaderPanelMode = 'tabs' | 'menu'
export type TaskHeaderAlign = 'left' | 'right'

// Legacy — kept for one-time read in `_loadState` migrations. New code uses
// the boolean pair `treeShowSubtasks` + `treeShowAllSubtasks`.
type LegacyTreeSubtaskMode = 'hide' | 'match' | 'all'

// Tab type (matches TabBar.tsx in app)
export type Tab =
  | { type: 'home' }
  | {
      type: 'task'
      taskId: string
      title: string
      status?: TaskStatus
      isSubTask?: boolean
      isTemporary?: boolean
    }

type TaskTab = Extract<Tab, { type: 'task' }>

export interface TaskLookupTask {
  id: string
  title?: string
  status?: TaskStatus
  parent_id?: string | null
  is_temporary?: boolean | number | null
  project_id?: string
  worktree_path?: string | null
}

export interface TaskLookupProject {
  id: string
  path?: string | null
}

export interface TaskLookup {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: Array<TaskLookupTask & Record<string, any>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projects: Array<TaskLookupProject & Record<string, any>>
}

interface TabState {
  // State
  tabs: Tab[]
  activeTabIndex: number
  activeView: ActiveView
  selectedProjectId: string
  closedTabs: TaskTab[]
  projectScopedTabs: boolean
  isLoaded: boolean
  // Registry id of the currently selected sidebar view (default 'projects').
  sidebarView: string
  // Custom pixel width override for the current resizable sidebar view. null = use view default.
  sidebarWidth: number | null
  // When true, the sidebar collapses to a hover-revealed floating panel.
  sidebarAutoHide: boolean
  // Tree-view status filter — task statuses to include.
  treeStatusFilter: string[]
  // Tree-view priority filter — priorities to include. Empty = no priority
  // constraint (all priorities pass).
  treePriorityFilter: number[]
  // Tree-view display options — show indicators on each task row.
  treeShowStatus: boolean
  treeShowPriority: boolean
  // Tree-view: render sub-tasks at all (off → roots only).
  treeShowSubtasks: boolean
  // Tree-view: when sub-tasks shown, include every descendant of a matching
  // root (off → only descendants that themselves pass the filter).
  treeShowAllSubtasks: boolean
  // Tree-view: when sub-tasks shown, include every undone (non-completed)
  // descendant of a matching root. Ignored when `treeShowAllSubtasks` is on.
  treeShowAllUndoneSubtasks: boolean
  // Tree-view: strikethrough completed (done) task rows.
  treeCrossOutDone: boolean
  // Tree-view: show only tasks with an active PTY/chat session (or pinned).
  treeShowOnlyActive: boolean
  // Tree-view: include temporary tasks in the tree.
  treeShowTemporary: boolean
  // Tree-view: include tasks with `is_blocked` flag set.
  treeShowBlocked: boolean
  // Tree-view: include tasks whose `snoozed_until` is in the future.
  treeShowSnoozed: boolean
  // Tree-view: bypass status filter — include every task that is not in a
  // terminal (done/canceled) status.
  treeShowAllOpen: boolean
  // Tree-view: show worktree pill on tasks that have a worktree_path.
  treeShowWorktree: boolean
  // Tree-view: group root tasks by status within each project.
  // Tree-view layout — decoupled from kanban filter.
  treeGroupBy: TreeGroupBy
  treeOrderBy: TreeOrderBy
  treeOrderDir: TreeOrderDir
  // When true, temporary tasks render in their own "Temporary" group at the top.
  // When false, they mix into their natural status/priority bucket.
  treeGroupTemporary: boolean
  // When true, pinned tasks render in their own "Pinned" group at the top.
  // When false, they mix into their natural status/priority bucket.
  treeGroupPinned: boolean
  // Show group headers for groups with zero tasks (respecting treeStatusFilter).
  treeShowEmptyGroups: boolean
  // Task-detail header layout.
  taskHeaderPanelMode: TaskHeaderPanelMode
  taskHeaderPanelAlign: TaskHeaderAlign
  taskHeaderTitleAlign: TaskHeaderAlign
  // projectId → taskId of last active task tab, or 'home' if home tab was last active
  projectLastActiveTab: Record<string, string>

  // Internal — synced by App.tsx, not subscribed to by components
  _taskLookup: TaskLookup

  // Pure tab actions
  setActiveTabIndex: (index: number) => void
  setActiveView: (view: ActiveView) => void
  setSelectedProjectId: (id: string) => void
  selectProject: (projectId: string) => void
  setProjectScopedTabs: (enabled: boolean) => void
  toggleProjectScopedTabs: () => void
  setSidebarView: (id: string) => void
  setSidebarWidth: (width: number | null) => void
  setSidebarAutoHide: (enabled: boolean) => void
  setTreeStatusFilter: (statuses: string[]) => void
  setTreePriorityFilter: (priorities: number[]) => void
  setTreeShowStatus: (show: boolean) => void
  setTreeShowPriority: (show: boolean) => void
  setTreeShowSubtasks: (show: boolean) => void
  setTreeShowAllSubtasks: (show: boolean) => void
  setTreeShowAllUndoneSubtasks: (show: boolean) => void
  setTreeCrossOutDone: (cross: boolean) => void
  setTreeShowOnlyActive: (only: boolean) => void
  setTreeShowTemporary: (show: boolean) => void
  setTreeShowBlocked: (show: boolean) => void
  setTreeShowSnoozed: (show: boolean) => void
  setTreeShowAllOpen: (show: boolean) => void
  setTreeShowWorktree: (show: boolean) => void
  setTreeGroupBy: (groupBy: TreeGroupBy) => void
  setTreeOrderBy: (orderBy: TreeOrderBy) => void
  setTreeOrderDir: (dir: TreeOrderDir) => void
  setTreeGroupTemporary: (group: boolean) => void
  setTreeGroupPinned: (group: boolean) => void
  setTreeShowEmptyGroups: (show: boolean) => void
  setTaskHeaderPanelMode: (mode: TaskHeaderPanelMode) => void
  setTaskHeaderPanelAlign: (align: TaskHeaderAlign) => void
  setTaskHeaderTitleAlign: (align: TaskHeaderAlign) => void
  setTabs: (tabs: Tab[]) => void
  reorderTabs: (from: number, to: number) => void
  openTask: (taskId: string) => void
  openTaskInBackground: (taskId: string) => void
  closeTab: (index: number) => void
  closeTabByTaskId: (taskId: string) => void
  goBack: () => void
  reopenClosedTab: () => void

  // Internal
  _loadState: (state: {
    tabs: Tab[]
    activeTabIndex: number
    activeView?: ActiveView
    selectedProjectId: string
    projectScopedTabs?: boolean
    sidebarView?: string
    sidebarWidth?: number | null
    sidebarAutoHide?: boolean
    treeStatusFilter?: string[]
    treePriorityFilter?: number[]
    treeShowStatus?: boolean
    treeShowPriority?: boolean
    treeShowSubtasks?: boolean
    treeShowAllSubtasks?: boolean
    treeShowAllUndoneSubtasks?: boolean
    treeSubtaskMode?: LegacyTreeSubtaskMode
    treeIncludeAllSubtasks?: boolean
    treeCrossOutDone?: boolean
    treeShowOnlyActive?: boolean
    treeShowTemporary?: boolean
    treeShowBlocked?: boolean
    treeShowSnoozed?: boolean
    treeShowAllOpen?: boolean
    treeHideInactive?: boolean
    treeHideClosed?: boolean
    treeShowWorktree?: boolean
    treeGroupBy?: TreeGroupBy
    treeOrderBy?: TreeOrderBy
    treeOrderDir?: TreeOrderDir
    treeGroupTemporary?: boolean
    treeGroupPinned?: boolean
    treeShowEmptyGroups?: boolean
    taskHeaderPanelMode?: TaskHeaderPanelMode
    taskHeaderPanelAlign?: TaskHeaderAlign
    taskHeaderTitleAlign?: TaskHeaderAlign
    projectLastActiveTab?: Record<string, string>
    closedTabs?: TaskTab[]
  }) => void
}

function findWorktreeInsertIndex(taskId: string, tabs: Tab[], lookup: TaskLookup): number {
  const task = lookup.tasks.find((t) => t.id === taskId)
  if (!task?.project_id) return tabs.length
  const project = lookup.projects.find((p) => p.id === task.project_id)
  const effectivePath = task.worktree_path || project?.path
  if (!effectivePath) return tabs.length
  let lastSibling = -1
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i]
    if (tab.type !== 'task') continue
    const t = lookup.tasks.find((x) => x.id === tab.taskId)
    if (!t?.project_id) continue
    const p = lookup.projects.find((pr) => pr.id === t.project_id)
    const otherPath = t.worktree_path || p?.path
    if (otherPath === effectivePath) {
      lastSibling = i
      break
    }
  }
  return lastSibling >= 0 ? lastSibling + 1 : tabs.length
}

export const useTabStore = create<TabState>()(
  subscribeWithSelector((set, get) => ({
    tabs: [{ type: 'home' }],
    activeTabIndex: 0,
    activeView: 'tabs' as ActiveView,
    selectedProjectId: '',
    closedTabs: [],
    projectScopedTabs: false,
    isLoaded: false,
    sidebarView: 'projects',
    sidebarWidth: null,
    sidebarAutoHide: false,
    treeStatusFilter: ['in_progress'],
    treePriorityFilter: [1, 2, 3, 4, 5],
    treeShowStatus: false,
    treeShowPriority: true,
    treeShowSubtasks: true,
    treeShowAllSubtasks: false,
    treeShowAllUndoneSubtasks: false,
    treeCrossOutDone: false,
    treeShowOnlyActive: false,
    treeShowTemporary: true,
    treeShowBlocked: true,
    treeShowSnoozed: true,
    treeShowAllOpen: true,
    treeShowWorktree: true,
    treeGroupBy: 'status',
    treeOrderBy: 'manual',
    treeOrderDir: 'asc',
    treeGroupTemporary: true,
    treeGroupPinned: true,
    treeShowEmptyGroups: false,
    taskHeaderPanelMode: 'tabs',
    taskHeaderPanelAlign: 'right',
    taskHeaderTitleAlign: 'left',
    projectLastActiveTab: {},
    _taskLookup: { tasks: [], projects: [] },

    setActiveTabIndex: (index) => set({ activeTabIndex: index, activeView: 'tabs' }),

    setActiveView: (view) => set({ activeView: view }),

    setSelectedProjectId: (id) => set({ selectedProjectId: id }),

    selectProject: (projectId) => {
      const { selectedProjectId, projectLastActiveTab, tabs } = get()
      if (selectedProjectId === projectId) {
        set({ activeTabIndex: 0, activeView: 'tabs' })
        return
      }
      const last = projectLastActiveTab[projectId]
      if (last && last !== 'home') {
        const idx = tabs.findIndex((t) => t.type === 'task' && t.taskId === last)
        if (idx >= 0) {
          set({ selectedProjectId: projectId, activeTabIndex: idx, activeView: 'tabs' })
          return
        }
      }
      set({ selectedProjectId: projectId, activeTabIndex: 0, activeView: 'tabs' })
    },

    setProjectScopedTabs: (enabled) => set({ projectScopedTabs: enabled }),

    toggleProjectScopedTabs: () => set((s) => ({ projectScopedTabs: !s.projectScopedTabs })),

    setSidebarView: (id) => set({ sidebarView: id }),

    setSidebarWidth: (width) => set({ sidebarWidth: width }),

    setSidebarAutoHide: (enabled) => set({ sidebarAutoHide: enabled }),

    setTreeStatusFilter: (statuses) => set({ treeStatusFilter: statuses }),
    setTreePriorityFilter: (priorities) => set({ treePriorityFilter: priorities }),

    setTreeShowStatus: (show) => set({ treeShowStatus: show }),

    setTreeShowPriority: (show) => set({ treeShowPriority: show }),

    setTreeShowSubtasks: (show) => set({ treeShowSubtasks: show }),
    setTreeShowAllSubtasks: (show) => set({ treeShowAllSubtasks: show }),
    setTreeShowAllUndoneSubtasks: (show) => set({ treeShowAllUndoneSubtasks: show }),

    setTreeCrossOutDone: (cross) => set({ treeCrossOutDone: cross }),

    setTreeShowOnlyActive: (only) => set({ treeShowOnlyActive: only }),
    setTreeShowTemporary: (show) => set({ treeShowTemporary: show }),
    setTreeShowBlocked: (show) => set({ treeShowBlocked: show }),
    setTreeShowSnoozed: (show) => set({ treeShowSnoozed: show }),
    setTreeShowAllOpen: (show) => set({ treeShowAllOpen: show }),

    setTreeShowWorktree: (show) => set({ treeShowWorktree: show }),

    setTreeGroupBy: (groupBy) => set({ treeGroupBy: groupBy }),
    setTreeOrderBy: (orderBy) => set({ treeOrderBy: orderBy }),
    setTreeOrderDir: (dir) => set({ treeOrderDir: dir }),
    setTreeGroupTemporary: (group) => set({ treeGroupTemporary: group }),
    setTreeGroupPinned: (group) => set({ treeGroupPinned: group }),
    setTreeShowEmptyGroups: (show) => set({ treeShowEmptyGroups: show }),
    setTaskHeaderPanelMode: (mode) => set({ taskHeaderPanelMode: mode }),
    setTaskHeaderPanelAlign: (align) => set({ taskHeaderPanelAlign: align }),
    setTaskHeaderTitleAlign: (align) => set({ taskHeaderTitleAlign: align }),

    setTabs: (tabs) => set({ tabs }),

    reorderTabs: (fromIndex, toIndex) => {
      const { tabs, activeTabIndex } = get()
      const newTabs = [...tabs]
      const [moved] = newTabs.splice(fromIndex, 1)
      newTabs.splice(toIndex, 0, moved)
      let newActive = activeTabIndex
      if (activeTabIndex === fromIndex) {
        newActive = toIndex
      } else if (fromIndex < activeTabIndex && toIndex >= activeTabIndex) {
        newActive = activeTabIndex - 1
      } else if (fromIndex > activeTabIndex && toIndex <= activeTabIndex) {
        newActive = activeTabIndex + 1
      }
      set({ tabs: newTabs, activeTabIndex: newActive })
    },

    openTask: (taskId) => {
      const { tabs, _taskLookup } = get()
      const existing = tabs.findIndex((t) => t.type === 'task' && t.taskId === taskId)
      if (existing >= 0) {
        set({ activeTabIndex: existing, activeView: 'tabs' })
      } else {
        const task = _taskLookup.tasks.find((t) => t.id === taskId)
        const title = task?.title || 'Task'
        const status = task?.status
        const isSubTask = !!task?.parent_id
        const isTemporary = !!task?.is_temporary
        const newTab: Tab = { type: 'task', taskId, title, status, isSubTask, isTemporary }
        const insertAt = findWorktreeInsertIndex(taskId, tabs, _taskLookup)
        const newTabs = [...tabs]
        newTabs.splice(insertAt, 0, newTab)
        set({ tabs: newTabs, activeTabIndex: insertAt, activeView: 'tabs' })
      }
    },

    openTaskInBackground: (taskId) => {
      const { tabs, _taskLookup } = get()
      const existing = tabs.findIndex((t) => t.type === 'task' && t.taskId === taskId)
      if (existing < 0) {
        const task = _taskLookup.tasks.find((t) => t.id === taskId)
        const title = task?.title || 'Task'
        const status = task?.status
        const isSubTask = !!task?.parent_id
        const isTemporary = !!task?.is_temporary
        const newTab: Tab = { type: 'task', taskId, title, status, isSubTask, isTemporary }
        const insertAt = findWorktreeInsertIndex(taskId, tabs, _taskLookup)
        const newTabs = [...tabs]
        newTabs.splice(insertAt, 0, newTab)
        set({ tabs: newTabs })
      }
    },

    // Note: intentionally does NOT reset activeView — closing a background tab
    // while viewing leaderboard/usage-analytics should not dismiss the overlay.
    closeTab: (index) => {
      const { tabs, activeTabIndex, closedTabs } = get()
      const tab = tabs[index]
      if (!tab || tab.type !== 'task') return
      // Push to closed stack (unless temporary — caller handles temp task cleanup)
      const task = get()._taskLookup.tasks.find((t) => t.id === tab.taskId)
      if (!task?.is_temporary) {
        const newClosed = [...closedTabs, tab]
        if (newClosed.length > 20) newClosed.shift()
        set({ closedTabs: newClosed })
      }
      const newTabs = tabs.filter((_, i) => i !== index)
      const newActive = activeTabIndex >= index ? Math.max(0, activeTabIndex - 1) : activeTabIndex
      set({ tabs: newTabs, activeTabIndex: newActive })
    },

    closeTabByTaskId: (taskId) => {
      const index = get().tabs.findIndex((t) => t.type === 'task' && t.taskId === taskId)
      if (index >= 0) get().closeTab(index)
    },

    goBack: () => {
      const { activeTabIndex } = get()
      if (activeTabIndex > 0) get().closeTab(activeTabIndex)
    },

    reopenClosedTab: () => {
      const { closedTabs, tabs, _taskLookup } = get()
      const taskIds = new Set(_taskLookup.tasks.map((t) => t.id))
      const newClosed = [...closedTabs]
      while (newClosed.length > 0) {
        const tab = newClosed.pop()!
        if (!taskIds.has(tab.taskId)) continue
        if (tabs.some((t) => t.type === 'task' && t.taskId === tab.taskId)) continue
        set({ closedTabs: newClosed })
        get().openTask(tab.taskId)
        return
      }
      set({ closedTabs: newClosed })
    },

    _loadState: (state) => {
      // Strip legacy leaderboard/usage-analytics tabs from persisted state
      const rawTabs =
        Array.isArray(state.tabs) && state.tabs.length > 0
          ? state.tabs
          : [{ type: 'home' as const }]
      const validTabs = rawTabs.filter(
        (t: { type: string }) => t.type === 'home' || t.type === 'task'
      )
      if (validTabs.length === 0 || validTabs[0]?.type !== 'home') {
        validTabs.unshift({ type: 'home' })
      }
      // Fresh app launch → kanban; Cmd+Shift+R reload → restore last tab
      const isReload =
        typeof sessionStorage !== 'undefined' && sessionStorage.getItem('sz:session') === '1'
      if (!isReload && typeof sessionStorage !== 'undefined')
        sessionStorage.setItem('sz:session', '1')
      const clampedIndex = isReload
        ? Math.max(0, Math.min(state.activeTabIndex ?? 0, validTabs.length - 1))
        : 0
      const activeView: ActiveView = isReload
        ? state.activeView === 'leaderboard' ||
          state.activeView === 'usage-analytics' ||
          state.activeView === 'context'
          ? state.activeView
          : 'tabs'
        : 'tabs'
      set({
        tabs: validTabs,
        activeTabIndex: clampedIndex,
        activeView,
        selectedProjectId:
          typeof state.selectedProjectId === 'string' ? state.selectedProjectId : '',
        projectScopedTabs: !!state.projectScopedTabs,
        sidebarView: typeof state.sidebarView === 'string' ? state.sidebarView : 'projects',
        sidebarWidth:
          typeof state.sidebarWidth === 'number' && state.sidebarWidth > 0
            ? state.sidebarWidth
            : null,
        sidebarAutoHide: !!state.sidebarAutoHide,
        treeStatusFilter:
          Array.isArray(state.treeStatusFilter) &&
          state.treeStatusFilter.every((s) => typeof s === 'string')
            ? state.treeStatusFilter
            : ['in_progress'],
        treePriorityFilter:
          Array.isArray(state.treePriorityFilter) &&
          state.treePriorityFilter.every((p) => typeof p === 'number')
            ? state.treePriorityFilter
            : [1, 2, 3, 4, 5],
        treeShowStatus: typeof state.treeShowStatus === 'boolean' ? state.treeShowStatus : false,
        treeShowPriority:
          typeof state.treeShowPriority === 'boolean' ? state.treeShowPriority : true,
        treeShowSubtasks:
          typeof state.treeShowSubtasks === 'boolean'
            ? state.treeShowSubtasks
            : state.treeSubtaskMode === 'hide'
              ? false
              : true,
        treeShowAllSubtasks:
          typeof state.treeShowAllSubtasks === 'boolean'
            ? state.treeShowAllSubtasks
            : state.treeSubtaskMode === 'all' || state.treeIncludeAllSubtasks === true,
        treeShowAllUndoneSubtasks:
          typeof state.treeShowAllUndoneSubtasks === 'boolean'
            ? state.treeShowAllUndoneSubtasks
            : false,
        treeCrossOutDone:
          typeof state.treeCrossOutDone === 'boolean' ? state.treeCrossOutDone : false,
        treeShowOnlyActive:
          typeof state.treeShowOnlyActive === 'boolean'
            ? state.treeShowOnlyActive
            : typeof state.treeHideInactive === 'boolean'
              ? state.treeHideInactive
              : typeof state.treeHideClosed === 'boolean'
                ? state.treeHideClosed
                : false,
        treeShowTemporary:
          typeof state.treeShowTemporary === 'boolean' ? state.treeShowTemporary : true,
        treeShowBlocked: typeof state.treeShowBlocked === 'boolean' ? state.treeShowBlocked : true,
        treeShowSnoozed: typeof state.treeShowSnoozed === 'boolean' ? state.treeShowSnoozed : true,
        treeShowAllOpen: typeof state.treeShowAllOpen === 'boolean' ? state.treeShowAllOpen : true,
        treeShowWorktree:
          typeof state.treeShowWorktree === 'boolean' ? state.treeShowWorktree : true,
        treeGroupBy:
          state.treeGroupBy === 'priority' || state.treeGroupBy === 'none'
            ? state.treeGroupBy
            : 'status',
        treeOrderBy:
          state.treeOrderBy === 'priority' ||
          state.treeOrderBy === 'due_date' ||
          state.treeOrderBy === 'title' ||
          state.treeOrderBy === 'created' ||
          state.treeOrderBy === 'last_interaction'
            ? state.treeOrderBy
            : 'manual',
        treeOrderDir: state.treeOrderDir === 'desc' ? 'desc' : 'asc',
        treeGroupTemporary:
          typeof state.treeGroupTemporary === 'boolean' ? state.treeGroupTemporary : true,
        treeGroupPinned: typeof state.treeGroupPinned === 'boolean' ? state.treeGroupPinned : true,
        treeShowEmptyGroups:
          typeof state.treeShowEmptyGroups === 'boolean' ? state.treeShowEmptyGroups : false,
        taskHeaderPanelMode: state.taskHeaderPanelMode === 'menu' ? 'menu' : 'tabs',
        taskHeaderPanelAlign: state.taskHeaderPanelAlign === 'left' ? 'left' : 'right',
        taskHeaderTitleAlign: state.taskHeaderTitleAlign === 'right' ? 'right' : 'left',
        projectLastActiveTab:
          state.projectLastActiveTab && typeof state.projectLastActiveTab === 'object'
            ? state.projectLastActiveTab
            : {},
        closedTabs: Array.isArray(state.closedTabs)
          ? state.closedTabs
              .filter(
                (t: { type?: string; taskId?: unknown }) =>
                  t?.type === 'task' && typeof t.taskId === 'string'
              )
              .slice(-20)
          : [],
        isLoaded: true
      })
    }
  }))
)

// Eagerly load persisted state at module scope — runs before any component mounts,
// eliminating race conditions between store hydration and React effects.
export const tabStoreReady: Promise<void> =
  typeof window !== 'undefined' && window.api?.settings
    ? (performance.mark('sz:tabStore:start'), window.api.settings.get('viewState'))
        .then((value) => {
          if (value) {
            try {
              useTabStore.getState()._loadState(JSON.parse(value))
            } catch {
              useTabStore.setState({ isLoaded: true })
            }
          } else {
            useTabStore
              .getState()
              ._loadState({ tabs: [], activeTabIndex: 0, selectedProjectId: '' })
          }
        })
        .catch(() => {
          // IPC failure — render with default state rather than permanent white screen
          useTabStore.setState({ isLoaded: true })
        })
        .finally(() => {
          performance.mark('sz:tabStore:end')
        })
    : Promise.resolve()

// Debounced persistence — subscribe to tab/index/project changes and save
let _debounceTimer: ReturnType<typeof setTimeout> | null = null

useTabStore.subscribe(
  (state) => ({
    tabs: state.tabs,
    activeTabIndex: state.activeTabIndex,
    activeView: state.activeView,
    selectedProjectId: state.selectedProjectId,
    projectScopedTabs: state.projectScopedTabs,
    sidebarView: state.sidebarView,
    sidebarWidth: state.sidebarWidth,
    sidebarAutoHide: state.sidebarAutoHide,
    treeStatusFilter: state.treeStatusFilter,
    treePriorityFilter: state.treePriorityFilter,
    treeShowStatus: state.treeShowStatus,
    treeShowPriority: state.treeShowPriority,
    treeShowSubtasks: state.treeShowSubtasks,
    treeShowAllSubtasks: state.treeShowAllSubtasks,
    treeShowAllUndoneSubtasks: state.treeShowAllUndoneSubtasks,
    treeCrossOutDone: state.treeCrossOutDone,
    treeShowOnlyActive: state.treeShowOnlyActive,
    treeShowTemporary: state.treeShowTemporary,
    treeShowBlocked: state.treeShowBlocked,
    treeShowSnoozed: state.treeShowSnoozed,
    treeShowAllOpen: state.treeShowAllOpen,
    treeShowWorktree: state.treeShowWorktree,
    treeGroupBy: state.treeGroupBy,
    treeOrderBy: state.treeOrderBy,
    treeOrderDir: state.treeOrderDir,
    treeGroupTemporary: state.treeGroupTemporary,
    treeGroupPinned: state.treeGroupPinned,
    treeShowEmptyGroups: state.treeShowEmptyGroups,
    taskHeaderPanelMode: state.taskHeaderPanelMode,
    taskHeaderPanelAlign: state.taskHeaderPanelAlign,
    taskHeaderTitleAlign: state.taskHeaderTitleAlign,
    projectLastActiveTab: state.projectLastActiveTab,
    closedTabs: state.closedTabs
  }),
  (slice) => {
    if (!useTabStore.getState().isLoaded) return
    if (_debounceTimer) clearTimeout(_debounceTimer)
    _debounceTimer = setTimeout(() => {
      window.api.settings.set('viewState', JSON.stringify(slice))
    }, 500)
  },
  { equalityFn: shallow }
)

// Record last active tab per project. Fires when active tab, tabs list,
// or selected project changes. Writes taskId for task tabs, 'home' for home.
useTabStore.subscribe(
  (state) => ({
    activeTabIndex: state.activeTabIndex,
    tabs: state.tabs,
    selectedProjectId: state.selectedProjectId,
    _taskLookup: state._taskLookup
  }),
  ({ activeTabIndex, tabs, selectedProjectId, _taskLookup }) => {
    if (!useTabStore.getState().isLoaded) return
    const tab = tabs[activeTabIndex]
    if (!tab) return
    const current = useTabStore.getState().projectLastActiveTab
    if (tab.type === 'task') {
      const projectId = _taskLookup.tasks.find((t) => t.id === tab.taskId)?.project_id
      if (!projectId) return
      if (current[projectId] === tab.taskId) return
      useTabStore.setState({ projectLastActiveTab: { ...current, [projectId]: tab.taskId } })
    } else if (tab.type === 'home') {
      if (!selectedProjectId) return
      if (current[selectedProjectId] === 'home') return
      useTabStore.setState({ projectLastActiveTab: { ...current, [selectedProjectId]: 'home' } })
    }
  },
  { equalityFn: shallow }
)
