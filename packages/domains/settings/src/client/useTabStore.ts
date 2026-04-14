import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { shallow } from 'zustand/shallow'
import type { TaskStatus } from '@slayzone/task/shared'

export type ActiveView = 'tabs' | 'leaderboard' | 'usage-analytics' | 'context'

// Tab type (matches TabBar.tsx in app)
export type Tab =
  | { type: 'home' }
  | { type: 'task'; taskId: string; title: string; status?: TaskStatus; isSubTask?: boolean; isTemporary?: boolean }

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

  // Internal — synced by App.tsx, not subscribed to by components
  _taskLookup: TaskLookup

  // Pure tab actions
  setActiveTabIndex: (index: number) => void
  setActiveView: (view: ActiveView) => void
  setSelectedProjectId: (id: string) => void
  setProjectScopedTabs: (enabled: boolean) => void
  toggleProjectScopedTabs: () => void
  setTabs: (tabs: Tab[]) => void
  reorderTabs: (from: number, to: number) => void
  openTask: (taskId: string) => void
  openTaskInBackground: (taskId: string) => void
  closeTab: (index: number) => void
  closeTabByTaskId: (taskId: string) => void
  goBack: () => void
  reopenClosedTab: () => void

  // Internal
  _loadState: (state: { tabs: Tab[]; activeTabIndex: number; activeView?: ActiveView; selectedProjectId: string; projectScopedTabs?: boolean }) => void
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
    _taskLookup: { tasks: [], projects: [] },

    setActiveTabIndex: (index) => set({ activeTabIndex: index, activeView: 'tabs' }),

    setActiveView: (view) => set({ activeView: view }),

    setSelectedProjectId: (id) => set({ selectedProjectId: id }),

    setProjectScopedTabs: (enabled) => set({ projectScopedTabs: enabled }),

    toggleProjectScopedTabs: () => set((s) => ({ projectScopedTabs: !s.projectScopedTabs })),

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
      const rawTabs = Array.isArray(state.tabs) && state.tabs.length > 0 ? state.tabs : [{ type: 'home' as const }]
      const validTabs = rawTabs.filter((t: { type: string }) => t.type === 'home' || t.type === 'task')
      if (validTabs.length === 0 || validTabs[0]?.type !== 'home') {
        validTabs.unshift({ type: 'home' })
      }
      // Fresh app launch → kanban; Cmd+Shift+R reload → restore last tab
      const isReload = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('sz:session') === '1'
      if (!isReload && typeof sessionStorage !== 'undefined') sessionStorage.setItem('sz:session', '1')
      const clampedIndex = isReload ? Math.max(0, Math.min(state.activeTabIndex ?? 0, validTabs.length - 1)) : 0
      const activeView: ActiveView = isReload
        ? (state.activeView === 'leaderboard' || state.activeView === 'usage-analytics' || state.activeView === 'context' ? state.activeView : 'tabs')
        : 'tabs'
      set({
        tabs: validTabs,
        activeTabIndex: clampedIndex,
        activeView,
        selectedProjectId: typeof state.selectedProjectId === 'string' ? state.selectedProjectId : '',
        projectScopedTabs: !!state.projectScopedTabs,
        isLoaded: true
      })
    }
  }))
)

// Eagerly load persisted state at module scope — runs before any component mounts,
// eliminating race conditions between store hydration and React effects.
export const tabStoreReady: Promise<void> = (typeof window !== 'undefined' && window.api?.settings
  ? (performance.mark('sz:tabStore:start'),
    window.api.settings.get('viewState')
  ).then((value) => {
    if (value) {
      try {
        useTabStore.getState()._loadState(JSON.parse(value))
      } catch {
        useTabStore.setState({ isLoaded: true })
      }
    } else {
      useTabStore.getState()._loadState(
        { tabs: [], activeTabIndex: 0, selectedProjectId: '' }
      )
    }
  }).catch(() => {
    // IPC failure — render with default state rather than permanent white screen
    useTabStore.setState({ isLoaded: true })
  }).finally(() => {
    performance.mark('sz:tabStore:end')
  })
  : Promise.resolve()
)

// Debounced persistence — subscribe to tab/index/project changes and save
let _debounceTimer: ReturnType<typeof setTimeout> | null = null

useTabStore.subscribe(
  (state) => ({ tabs: state.tabs, activeTabIndex: state.activeTabIndex, activeView: state.activeView, selectedProjectId: state.selectedProjectId, projectScopedTabs: state.projectScopedTabs }),
  (slice) => {
    if (!useTabStore.getState().isLoaded) return
    if (_debounceTimer) clearTimeout(_debounceTimer)
    _debounceTimer = setTimeout(() => {
      window.api.settings.set('viewState', JSON.stringify(slice))
    }, 500)
  },
  { equalityFn: shallow }
)
