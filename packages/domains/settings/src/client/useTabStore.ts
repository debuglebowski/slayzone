import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { shallow } from 'zustand/shallow'
import type { TaskStatus } from '@slayzone/task/shared'

// Tab type (matches TabBar.tsx in app)
export type Tab =
  | { type: 'home' }
  | { type: 'leaderboard'; title: string }
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
  selectedProjectId: string
  closedTabs: TaskTab[]
  isLoaded: boolean

  // Internal — synced by App.tsx, not subscribed to by components
  _taskLookup: TaskLookup

  // Pure tab actions
  setActiveTabIndex: (index: number) => void
  setSelectedProjectId: (id: string) => void
  setTabs: (tabs: Tab[]) => void
  reorderTabs: (from: number, to: number) => void
  openTask: (taskId: string) => void
  openTaskInBackground: (taskId: string) => void
  closeTab: (index: number) => void
  closeTabByTaskId: (taskId: string) => void
  goBack: () => void
  reopenClosedTab: () => void

  // Internal
  _loadState: (state: { tabs: Tab[]; activeTabIndex: number; selectedProjectId: string }, opts?: { leaderboardEnabled?: boolean }) => void
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
    selectedProjectId: '',
    closedTabs: [],
    isLoaded: false,
    _taskLookup: { tasks: [], projects: [] },

    setActiveTabIndex: (index) => set({ activeTabIndex: index }),

    setSelectedProjectId: (id) => set({ selectedProjectId: id }),

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
        set({ activeTabIndex: existing })
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
        set({ tabs: newTabs, activeTabIndex: insertAt })
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

    _loadState: (state, opts?: { leaderboardEnabled?: boolean }) => {
      const leaderboardEnabled = opts?.leaderboardEnabled ?? true
      const validTabs = Array.isArray(state.tabs) && state.tabs.length > 0 ? state.tabs : [{ type: 'home' as const }]
      if (validTabs[0]?.type !== 'home') {
        validTabs.unshift({ type: 'home' })
      }
      if (leaderboardEnabled && !validTabs.some((t) => t.type === 'leaderboard')) {
        const homeIdx = validTabs.findIndex((t) => t.type === 'home')
        validTabs.splice(homeIdx + 1, 0, { type: 'leaderboard', title: 'Leaderboard' })
      }
      if (!leaderboardEnabled) {
        const lbIdx = validTabs.findIndex((t) => t.type === 'leaderboard')
        if (lbIdx >= 0) validTabs.splice(lbIdx, 1)
      }
      const clampedIndex = Math.max(0, Math.min(state.activeTabIndex ?? 0, validTabs.length - 1))
      set({
        tabs: validTabs,
        activeTabIndex: clampedIndex,
        selectedProjectId: typeof state.selectedProjectId === 'string' ? state.selectedProjectId : '',
        isLoaded: true
      })
    }
  }))
)

// Eagerly load persisted state at module scope — runs before any component mounts,
// eliminating race conditions between store hydration and React effects.
export const tabStoreReady: Promise<void> = (typeof window !== 'undefined' && window.api?.settings
  ? Promise.all([
    window.api.settings.get('viewState'),
    window.api.settings.get('leaderboard_enabled')
  ]).then(([value, lbVal]) => {
    const leaderboardEnabled = lbVal !== '0'
    if (value) {
      try {
        useTabStore.getState()._loadState(JSON.parse(value), { leaderboardEnabled })
      } catch {
        useTabStore.setState({ isLoaded: true })
      }
    } else {
      useTabStore.getState()._loadState(
        { tabs: [], activeTabIndex: 0, selectedProjectId: '' },
        { leaderboardEnabled }
      )
    }
  }).catch(() => {
    // IPC failure — render with default state rather than permanent white screen
    useTabStore.setState({ isLoaded: true })
  })
  : Promise.resolve()
)

// Debounced persistence — subscribe to tab/index/project changes and save
let _debounceTimer: ReturnType<typeof setTimeout> | null = null

useTabStore.subscribe(
  (state) => ({ tabs: state.tabs, activeTabIndex: state.activeTabIndex, selectedProjectId: state.selectedProjectId }),
  (slice) => {
    if (!useTabStore.getState().isLoaded) return
    if (_debounceTimer) clearTimeout(_debounceTimer)
    _debounceTimer = setTimeout(() => {
      window.api.settings.set('viewState', JSON.stringify(slice))
    }, 500)
  },
  { equalityFn: shallow }
)
