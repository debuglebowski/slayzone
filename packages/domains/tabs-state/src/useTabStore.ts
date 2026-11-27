import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { shallow } from 'zustand/shallow'
import { hubAllows, useHubRegistryStore } from '@slayzone/transport/client'
import { getHubClient, getTrpcClient, type TabsStateTrpcClient } from './trpc'
import { startOpenTabsSync } from './open-tabs-sync'
import type { TaskStatus } from '@slayzone/task-contracts'
import type { ColumnConfig } from '@slayzone/projects-contracts'
import {
  DEFAULT_TREE_DISPLAY,
  pickTreeDisplay,
  type TreeGroupBy,
  type TreeOrderBy,
  type TreeOrderDir
} from './tree-display'
import {
  cloneSpec,
  defaultLenses,
  liveSpec,
  migrateLenses,
  newLensId,
  parseLiveLensFields,
  resetLens,
  specToLive,
  TODAY_LENS_ID,
  uniqueLensName,
  visibleLenses,
  type Lens,
  type LensGroup,
  type LensLook,
  type LiveLensFields
} from './lenses'

export type ActiveView = 'tabs' | 'leaderboard' | 'usage-analytics' | 'context'

export type { TreeGroupBy, TreeOrderBy, TreeOrderDir }

export type TaskHeaderPanelMode = 'tabs' | 'menu'
export type TaskHeaderAlign = 'left' | 'right'

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
      /**
       * The hub that owns the task, recorded once its task has been seen (and
       * saved with the tabs). A tab is closed for a missing task only once THIS
       * hub has answered — another hub answering first proves nothing. Absent
       * (not seen yet, or saved before it was recorded) = wait for every hub.
       */
      hubId?: string
    }

type TaskTab = Extract<Tab, { type: 'task' }>

/**
 * An entry on the reopen (⌘⇧T) stack. `discarded` marks a tab whose close also
 * deleted its task — a temporary task has no home outside its tab. Reopening it
 * restores the task first, on `discarded.hubId`: the hub the close deleted it on
 * (absent = default hub), captured then because a deleted task drops out of the
 * hub-ownership map.
 */
export type ClosedTab = TaskTab & { discarded?: { hubId?: string } }

/**
 * Brings a `discarded` task back on its hub. Resolves to the restored task, or
 * null when it's gone for good (e.g. purged at boot). Throws when the restore
 * couldn't be attempted (hub unreachable) — the entry then stays on the stack.
 */
export type ClosedTabRestorer = (tab: ClosedTab) => Promise<TaskLookupTask | null>

export interface TaskLookupTask {
  id: string
  title?: string
  status?: TaskStatus
  parent_id?: string | null
  is_temporary?: boolean | number | null
  project_id?: string
  has_worktree?: boolean
}

/**
 * A task's worktree path as the client has it (§9 Phase 7d: read from the task's
 * computer; the board row carries none). Undefined = not known. Installed by the app
 * (from its path cache); only used to place a new tab next to its checkout siblings.
 */
let worktreePathOf: (task: TaskLookupTask) => string | null | undefined = () => undefined
export function setTabWorktreePathResolver(
  resolver: (task: TaskLookupTask) => string | null | undefined
): void {
  worktreePathOf = resolver
}

export interface TaskLookupProject {
  id: string
  path?: string | null
  /** Kanban column set — App.tsx reads it off the lookup to pick a status when
   *  converting a temporary task. */
  columns_config?: ColumnConfig[] | null
  /** Multi-hub: owning hub id (App fills it from useTasksData.hubIdByProject).
   *  Absent → default hub, so single-hub warm-pool routing is unchanged. */
  hubId?: string
}

/**
 * Callers hand in whole `Task` / `Project` records; the field sets above are
 * the only ones this store (or its readers) touch, and structural typing lets
 * the rest ride along untouched.
 */
export interface TaskLookup {
  tasks: TaskLookupTask[]
  projects: TaskLookupProject[]
}

interface TabState extends LiveLensFields {
  // State
  tabs: Tab[]
  activeTabIndex: number
  activeView: ActiveView
  selectedProjectId: string
  closedTabs: ClosedTab[]
  /**
   * Per hub: its open task tabs as this client and the hub last agreed on (tab-bar
   * order). The base of the three-way merge in `open-tabs-sync.ts`; absent = never
   * synced with that hub.
   */
  openTabsSync: Record<string, string[]>
  projectScopedTabs: boolean
  isLoaded: boolean
  // Registry id of the currently selected sidebar view (default 'projects').
  sidebarView: string
  // Custom pixel width override for the current resizable sidebar view. null = use view default.
  sidebarWidth: number | null
  // When true, the sidebar collapses to a hover-revealed floating panel.
  sidebarAutoHide: boolean
  // The tree display settings (`TreeDisplay`: the `tree*` filter/grouping/row fields)
  // and the lens-driven live fields (`LiveLensFields`) come in through `extends`.
  //
  // Saved sidebar presets (`lenses.ts`), in menu order, and the one applied. Persisted
  // in this same `viewState` slice rather than a settings key of their own: the live
  // `tree*` fields they are applied to and compared against are here, so the upgrade
  // migration (current settings → "Today") reads both from one record, and a reload
  // can never restore lenses and live state from two different moments. One write,
  // one read, one retry path (`loadTabStoreState`).
  lenses: Lens[]
  activeLensId: string
  // Accordion look: the one project expanded (null = none). Separate from
  // `treeOpenProjects` so switching to Accordion and back leaves the cards as they were.
  treeAccordionOpen: string | null
  // projectId → whether that project's row is expanded in the tree view. Lives
  // here rather than in TreeView component state so a remount (renderer reload,
  // wake from sleep) doesn't silently reset every project to collapsed.
  treeOpenProjects: Record<string, boolean>
  // Each slot is a hub ID; rows within a hub retain server order.
  sidebarHubOrder: string[]
  // Explode-mode arrangement. Task ids in the order the user dragged them into,
  // and the ids parked in the header tray. Persisted for the same reason as
  // `treeOpenProjects`: a renderer reload or a restart would otherwise silently
  // throw away a layout the user deliberately built. Reconciled against the open
  // tabs on read, so stale ids from closed tasks are harmless.
  explodeOrder: string[]
  explodeMinimized: string[]
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
  // `opts.home` forces the project's home/kanban tab (used by the Home icon),
  // bypassing the restore-last-active-tab behavior used by rail/folder/search.
  selectProject: (projectId: string, opts?: { home?: boolean }) => void
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
  setTreeShowTags: (show: boolean) => void
  setTreeShowBlockedBadge: (show: boolean) => void
  setTreeGroupBy: (groupBy: TreeGroupBy) => void
  setTreeOrderBy: (orderBy: TreeOrderBy) => void
  setTreeOrderDir: (dir: TreeOrderDir) => void
  setTreeGroupTemporary: (group: boolean) => void
  setTreeGroupBlocked: (group: boolean) => void
  setTreeGroupPinned: (group: boolean) => void
  setTreeShowEmptyGroups: (show: boolean) => void
  setTreeProjectOpen: (projectId: string, open: boolean) => void
  setTreeProjectsOpen: (projectIds: string[], open: boolean) => void
  setTreeShowAllProjects: (show: boolean) => void
  setTreeLensGroup: (group: LensGroup) => void
  setTreeLensLook: (look: LensLook) => void
  setTreeNeedsYou: (on: boolean) => void
  setTreeAccordionOpen: (projectId: string | null) => void
  // Lenses. Every edit goes to the live fields; these move lenses in and out of them.
  /** Apply a lens: write its settings to the live fields and make it active. */
  applyLens: (id: string) => void
  /** Apply the `index`-th visible lens (⌃1–9). Out of range = nothing. */
  applyLensAt: (index: number) => void
  /** Save the live settings into the active lens (and rename it when `name` is given). */
  saveActiveLens: (name?: string) => void
  /** Save the live settings as a new lens, made active. Returns its id. */
  saveLensAs: (name: string) => string
  /** Drop unsaved edits: re-apply the active lens. */
  revertActiveLens: () => void
  /** A new lens from the live settings ("New lens"), made active. Returns its id. */
  createLens: () => string
  /** A copy of a lens right after it, applied. Returns its id. */
  duplicateLens: (id: string) => string
  /** Delete a user lens (built-ins only hide). */
  deleteLens: (id: string) => void
  renameLens: (id: string, name: string) => void
  /** Hide or show a lens in the menu; the last visible one stays. */
  setLensHidden: (id: string, hidden: boolean) => void
  moveLens: (id: string, toIndex: number) => void
  /** A built-in back as it ships (re-applied when active). */
  resetLensToDefault: (id: string) => void
  setSidebarHubOrder: (hubOrder: string[]) => void
  setExplodeArrangement: (arrangement: { order?: string[]; minimized?: string[] }) => void
  setTaskHeaderPanelMode: (mode: TaskHeaderPanelMode) => void
  setTaskHeaderPanelAlign: (align: TaskHeaderAlign) => void
  setTaskHeaderTitleAlign: (align: TaskHeaderAlign) => void
  setTabs: (tabs: Tab[]) => void
  reorderTabs: (from: number, to: number) => void
  openTask: (taskId: string) => void
  openTaskInBackground: (taskId: string) => void
  /** `discarded`: this close also deletes the task (see `ClosedTab`). */
  closeTab: (index: number, discarded?: ClosedTab['discarded']) => void
  closeTabByTaskId: (taskId: string) => void
  goBack: () => void
  /**
   * Reopen the most recently closed tab that still can be, skipping ones already
   * open or whose task is gone. A `discarded` entry is first restored through
   * `restore`; without one it's skipped like any other gone task.
   */
  reopenClosedTab: (restore?: ClosedTabRestorer) => Promise<void>

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
    // Display + lens fields, the saved lenses and any legacy keys: parsed in
    // `parseLiveLensFields` / `migrateLenses`, which validate every value.
    [key: `tree${string}`]: unknown
    lenses?: unknown
    activeLensId?: unknown
    treeOpenProjects?: Record<string, boolean>
    sidebarHubOrder?: string[]
    explodeOrder?: string[]
    explodeMinimized?: string[]
    taskHeaderPanelMode?: TaskHeaderPanelMode
    taskHeaderPanelAlign?: TaskHeaderAlign
    taskHeaderTitleAlign?: TaskHeaderAlign
    projectLastActiveTab?: Record<string, string>
    closedTabs?: ClosedTab[]
    openTabsSync?: Record<string, unknown>
  }) => void
}

/** A persisted `closedTabs` entry, or null when it isn't one. `discarded` drives a
 *  hub write on reopen, so a malformed one is dropped rather than trusted. */
export function parseClosedTab(raw: unknown): ClosedTab | null {
  const t = raw as Partial<ClosedTab> | null
  if (t?.type !== 'task' || typeof t.taskId !== 'string') return null
  const { discarded, ...tab } = t as ClosedTab
  const hubId: unknown = discarded && typeof discarded === 'object' ? discarded.hubId : null
  if (hubId === undefined) return { ...tab, discarded: {} }
  if (typeof hubId === 'string') return { ...tab, discarded: { hubId } }
  return tab
}

function findWorktreeInsertIndex(taskId: string, tabs: Tab[], lookup: TaskLookup): number {
  const task = lookup.tasks.find((t) => t.id === taskId)
  if (!task?.project_id) return tabs.length
  const project = lookup.projects.find((p) => p.id === task.project_id)
  const checkoutOf = (t: TaskLookupTask, p: TaskLookupProject | undefined) =>
    t.has_worktree ? worktreePathOf(t) : p?.path
  const effectivePath = checkoutOf(task, project)
  if (!effectivePath) return tabs.length
  let lastSibling = -1
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i]
    if (tab.type !== 'task') continue
    const t = lookup.tasks.find((x) => x.id === tab.taskId)
    if (!t?.project_id) continue
    const p = lookup.projects.find((pr) => pr.id === t.project_id)
    const otherPath = checkoutOf(t, p)
    if (otherPath === effectivePath) {
      lastSibling = i
      break
    }
  }
  return lastSibling >= 0 ? lastSibling + 1 : tabs.length
}

/** The persisted `openTabsSync`: hub id → task ids; anything else is dropped. */
function parseOpenTabsSync(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [hubId, ids] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(ids)) out[hubId] = ids.filter((id): id is string => typeof id === 'string')
  }
  return out
}

export const useTabStore = create<TabState>()(
  subscribeWithSelector((set, get) => ({
    tabs: [{ type: 'home' }],
    activeTabIndex: 0,
    activeView: 'tabs' as ActiveView,
    selectedProjectId: '',
    closedTabs: [],
    openTabsSync: {},
    projectScopedTabs: false,
    isLoaded: false,
    sidebarView: 'tree',
    sidebarWidth: null,
    sidebarAutoHide: false,
    ...pickTreeDisplay(DEFAULT_TREE_DISPLAY),
    treeLensGroup: 'project' as LensGroup,
    treeLensLook: 'cards' as LensLook,
    treeNeedsYou: false,
    treeAccordionOpen: null,
    lenses: defaultLenses(),
    activeLensId: TODAY_LENS_ID,
    treeOpenProjects: {},
    treeShowAllProjects: false,
    sidebarHubOrder: [],
    explodeOrder: [],
    explodeMinimized: [],
    taskHeaderPanelMode: 'tabs',
    taskHeaderPanelAlign: 'right',
    taskHeaderTitleAlign: 'left',
    projectLastActiveTab: {},
    _taskLookup: { tasks: [], projects: [] },

    setActiveTabIndex: (index) => set({ activeTabIndex: index, activeView: 'tabs' }),

    setActiveView: (view) => set({ activeView: view }),

    setSelectedProjectId: (id) => set({ selectedProjectId: id }),

    selectProject: (projectId, opts) => {
      const { selectedProjectId, projectLastActiveTab, tabs } = get()
      // Home icon (opts.home) always lands on the home/kanban tab, even when
      // switching from another project. Same-project clicks also reset to home.
      if (opts?.home || selectedProjectId === projectId) {
        set({ selectedProjectId: projectId, activeTabIndex: 0, activeView: 'tabs' })
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
    setTreeShowTags: (show) => set({ treeShowTags: show }),
    setTreeShowBlockedBadge: (show) => set({ treeShowBlockedBadge: show }),

    setTreeGroupBy: (groupBy) => set({ treeGroupBy: groupBy }),
    setTreeOrderBy: (orderBy) => set({ treeOrderBy: orderBy }),
    setTreeOrderDir: (dir) => set({ treeOrderDir: dir }),
    setTreeGroupTemporary: (group) => set({ treeGroupTemporary: group }),
    setTreeGroupBlocked: (group) => set({ treeGroupBlocked: group }),
    setTreeGroupPinned: (group) => set({ treeGroupPinned: group }),
    setTreeShowEmptyGroups: (show) => set({ treeShowEmptyGroups: show }),

    setTreeProjectOpen: (projectId, open) =>
      set((s) => ({ treeOpenProjects: { ...s.treeOpenProjects, [projectId]: open } })),
    setTreeProjectsOpen: (projectIds, open) =>
      set((s) => ({
        treeOpenProjects: {
          ...s.treeOpenProjects,
          ...Object.fromEntries(projectIds.map((id) => [id, open]))
        }
      })),
    setTreeShowAllProjects: (treeShowAllProjects) => set({ treeShowAllProjects }),
    setTreeLensGroup: (treeLensGroup) => set({ treeLensGroup }),
    setTreeLensLook: (treeLensLook) => set({ treeLensLook }),
    setTreeNeedsYou: (treeNeedsYou) => set({ treeNeedsYou }),
    setTreeAccordionOpen: (treeAccordionOpen) => set({ treeAccordionOpen }),

    applyLens: (id) => {
      const lens = get().lenses.find((l) => l.id === id)
      if (lens) set({ ...specToLive(lens.spec), activeLensId: id })
    },
    applyLensAt: (index) => {
      const lens = visibleLenses(get().lenses)[index]
      if (lens) get().applyLens(lens.id)
    },
    saveActiveLens: (name) => {
      const { lenses, activeLensId } = get()
      const spec = liveSpec(get())
      const trimmed = name?.trim()
      set({
        lenses: lenses.map((l) =>
          l.id === activeLensId ? { ...l, spec, name: trimmed || l.name } : l
        )
      })
    },
    saveLensAs: (name) => {
      const { lenses } = get()
      const lens: Lens = {
        id: newLensId(),
        name: name.trim() || uniqueLensName(lenses, 'New lens'),
        icon: 'lens',
        builtin: null,
        hidden: false,
        spec: liveSpec(get())
      }
      set({ lenses: [...lenses, lens], activeLensId: lens.id })
      return lens.id
    },
    revertActiveLens: () => get().applyLens(get().activeLensId),
    createLens: () => get().saveLensAs(uniqueLensName(get().lenses, 'New lens')),
    duplicateLens: (id) => {
      const { lenses } = get()
      const index = lenses.findIndex((l) => l.id === id)
      if (index < 0) return id
      const source = lenses[index]
      const copy: Lens = {
        id: newLensId(),
        name: uniqueLensName(lenses, `${source.name} copy`),
        icon: source.icon,
        builtin: null,
        hidden: false,
        spec: cloneSpec(source.spec)
      }
      set({ lenses: [...lenses.slice(0, index + 1), copy, ...lenses.slice(index + 1)] })
      get().applyLens(copy.id)
      return copy.id
    },
    deleteLens: (id) => {
      const { lenses, activeLensId } = get()
      const lens = lenses.find((l) => l.id === id)
      if (!lens || lens.builtin) return
      const rest = lenses.filter((l) => l.id !== id)
      const next =
        visibleLenses(rest).length > 0
          ? rest
          : rest.map((l, i) => (i === 0 ? { ...l, hidden: false } : l))
      set({ lenses: next })
      if (activeLensId === id) get().applyLens(visibleLenses(next)[0].id)
    },
    renameLens: (id, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      set({ lenses: get().lenses.map((l) => (l.id === id ? { ...l, name: trimmed } : l)) })
    },
    setLensHidden: (id, hidden) => {
      const { lenses } = get()
      if (hidden && visibleLenses(lenses).every((l) => l.id === id)) return
      set({ lenses: lenses.map((l) => (l.id === id ? { ...l, hidden } : l)) })
    },
    moveLens: (id, toIndex) => {
      const lenses = [...get().lenses]
      const from = lenses.findIndex((l) => l.id === id)
      if (from < 0) return
      const [lens] = lenses.splice(from, 1)
      lenses.splice(Math.max(0, Math.min(toIndex, lenses.length)), 0, lens)
      set({ lenses })
    },
    resetLensToDefault: (id) => {
      set({ lenses: get().lenses.map((l) => (l.id === id ? resetLens(l) : l)) })
      if (get().activeLensId === id) get().applyLens(id)
    },
    setSidebarHubOrder: (sidebarHubOrder) => set({ sidebarHubOrder }),
    // Partial on purpose: a drag changes only the order and a minimize changes only
    // the tray, so neither has to restate the other and race it.
    setExplodeArrangement: ({ order, minimized }) =>
      set((s) => ({
        explodeOrder: order ?? s.explodeOrder,
        explodeMinimized: minimized ?? s.explodeMinimized
      })),
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
    closeTab: (index, discarded) => {
      const { tabs, activeTabIndex, closedTabs } = get()
      const tab = tabs[index]
      if (!tab || tab.type !== 'task') return
      const newClosed: ClosedTab[] = [...closedTabs, discarded ? { ...tab, discarded } : tab]
      if (newClosed.length > 20) newClosed.shift()
      const newTabs = tabs.filter((_, i) => i !== index)
      const newActive = activeTabIndex >= index ? Math.max(0, activeTabIndex - 1) : activeTabIndex
      set({ tabs: newTabs, activeTabIndex: newActive, closedTabs: newClosed })
    },

    closeTabByTaskId: (taskId) => {
      const index = get().tabs.findIndex((t) => t.type === 'task' && t.taskId === taskId)
      if (index >= 0) get().closeTab(index)
    },

    goBack: () => {
      const { activeTabIndex } = get()
      if (activeTabIndex > 0) get().closeTab(activeTabIndex)
    },

    reopenClosedTab: async (restore) => {
      for (;;) {
        const { closedTabs, tabs, _taskLookup } = get()
        const tab = closedTabs.at(-1)
        if (!tab) return
        // Pop before any await, so a second ⌘⇧T mid-restore takes the next entry.
        set({ closedTabs: closedTabs.slice(0, -1) })
        if (tabs.some((t) => t.type === 'task' && t.taskId === tab.taskId)) continue
        if (_taskLookup.tasks.some((t) => t.id === tab.taskId)) {
          get().openTask(tab.taskId)
          return
        }
        if (!tab.discarded || !restore) continue
        let restored: TaskLookupTask | null
        try {
          restored = await restore(tab)
        } catch (err) {
          set({ closedTabs: [...get().closedTabs, tab] })
          throw err
        }
        if (!restored) continue
        // The board's lookup only catches up on its next sync; openTask reads the
        // title and temporary-ness from it now.
        const lookup = get()._taskLookup
        if (!lookup.tasks.some((t) => t.id === restored.id)) {
          set({ _taskLookup: { ...lookup, tasks: [restored, ...lookup.tasks] } })
        }
        get().openTask(restored.id)
        return
      }
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
      // The live sidebar as saved; on the upgrade to lenses it also seeds "Today".
      const live = parseLiveLensFields(state)
      const { lenses, activeLensId } = migrateLenses(state, live)
      set({
        tabs: validTabs,
        activeTabIndex: clampedIndex,
        activeView,
        selectedProjectId:
          typeof state.selectedProjectId === 'string' ? state.selectedProjectId : '',
        projectScopedTabs: !!state.projectScopedTabs,
        sidebarView: typeof state.sidebarView === 'string' ? state.sidebarView : 'tree',
        sidebarWidth:
          typeof state.sidebarWidth === 'number' && state.sidebarWidth > 0
            ? state.sidebarWidth
            : null,
        sidebarAutoHide: !!state.sidebarAutoHide,
        ...live,
        lenses,
        activeLensId,
        treeAccordionOpen:
          typeof state.treeAccordionOpen === 'string' ? state.treeAccordionOpen : null,
        treeOpenProjects:
          state.treeOpenProjects && typeof state.treeOpenProjects === 'object'
            ? state.treeOpenProjects
            : {},
        // Element-level validation: this JSON is on disk and a malformed entry
        // would flow straight into layout as an undefined task id.
        sidebarHubOrder: Array.isArray(state.sidebarHubOrder)
          ? state.sidebarHubOrder.filter((id): id is string => typeof id === 'string')
          : [],
        explodeOrder: Array.isArray(state.explodeOrder)
          ? state.explodeOrder.filter((id): id is string => typeof id === 'string')
          : [],
        explodeMinimized: Array.isArray(state.explodeMinimized)
          ? state.explodeMinimized.filter((id): id is string => typeof id === 'string')
          : [],
        taskHeaderPanelMode: state.taskHeaderPanelMode === 'menu' ? 'menu' : 'tabs',
        taskHeaderPanelAlign: state.taskHeaderPanelAlign === 'left' ? 'left' : 'right',
        taskHeaderTitleAlign: state.taskHeaderTitleAlign === 'right' ? 'right' : 'left',
        projectLastActiveTab:
          state.projectLastActiveTab && typeof state.projectLastActiveTab === 'object'
            ? state.projectLastActiveTab
            : {},
        closedTabs: Array.isArray(state.closedTabs)
          ? state.closedTabs
              .map(parseClosedTab)
              .filter((t): t is ClosedTab => t !== null)
              .slice(-20)
          : [],
        openTabsSync: parseOpenTabsSync(state.openTabsSync),
        isLoaded: true
      })
    }
  }))
)

export async function loadTabStoreState(): Promise<void> {
  if (typeof window === 'undefined') return
  performance.mark('sz:tabStore:start')
  try {
    applySavedViewState(await getTrpcClient().settings.get.query({ key: 'viewState' }))
  } catch {
    // Unreadable is not empty: the app is usable now, but nothing is saved until
    // the saved tabs have been read — or the first tab change would save this
    // boot's (empty) list over every saved tab.
    _persistenceBlocked = true
    useTabStore.setState({ isLoaded: true })
    void retrySavedViewState()
  } finally {
    performance.mark('sz:tabStore:end')
  }
  if (!_persistenceBlocked) startTabSync()
  await restoreActiveSessionTabs()
}

let _stopTabSync: (() => void) | null = null

/**
 * Each task tab with the hub it belongs to: the hub recorded on the tab, else its
 * task's project's hub (`_taskLookup`; a project with none is the default hub's), else
 * unknown — a task not seen yet. A tab opened after the task list loaded has no hub
 * recorded until the list changes again, so the recorded one alone is not enough.
 */
export function resolveTaskTabHubs(
  tabs: readonly Tab[],
  lookup: TaskLookup,
  defaultHubId: string
): { taskId: string; hubId: string | undefined }[] {
  const projectOf = new Map(lookup.tasks.map((t) => [t.id, t.project_id]))
  const hubOfProject = new Map(lookup.projects.map((p) => [p.id, p.hubId ?? defaultHubId]))
  return tabs.flatMap((t) => {
    if (t.type !== 'task') return []
    const projectId = projectOf.get(t.taskId)
    const hubId = t.hubId ?? (projectId ? hubOfProject.get(projectId) : undefined)
    return [{ taskId: t.taskId, hubId }]
  })
}

/**
 * Keep this window's task tabs and each hub's open tabs agreeing (`open-tabs-sync.ts`),
 * from the moment the saved tabs are in — before, the empty boot list would only add
 * every hub's tabs on top of the ones about to load. Once per window.
 */
function startTabSync(): void {
  if (_stopTabSync || _persistenceStopped) return
  const taskTabs = (state: TabState) =>
    resolveTaskTabHubs(state.tabs, state._taskLookup, useHubRegistryStore.getState().defaultHubId)
  // Only a change to which task tabs are open, their order or their hub reaches the
  // sync — not a title or status update.
  const taskTabsKey = (state: TabState): string =>
    taskTabs(state)
      .map((t) => `${t.taskId}@${t.hubId ?? ''}`)
      .join(',')
  _stopTabSync = startOpenTabsSync({
    taskTabs: () => taskTabs(useTabStore.getState()),
    openInBackground: (taskId) => useTabStore.getState().openTaskInBackground(taskId),
    close: (taskId) => useTabStore.getState().closeTabByTaskId(taskId),
    base: (hubId) => useTabStore.getState().openTabsSync[hubId],
    setBase: (hubId, taskIds) =>
      useTabStore.setState((s) => ({ openTabsSync: { ...s.openTabsSync, [hubId]: taskIds } })),
    onTabsChanged: (listener) => useTabStore.subscribe(taskTabsKey, listener)
  })
}

function applySavedViewState(value: string | null | undefined): void {
  if (value) {
    try {
      useTabStore.getState()._loadState(JSON.parse(value))
    } catch {
      // Corrupt: nothing to keep — this boot's state replaces it.
      useTabStore.setState({ isLoaded: true })
    }
  } else {
    useTabStore.getState()._loadState({ tabs: [], activeTabIndex: 0, selectedProjectId: '' })
  }
}

const SAVED_VIEW_STATE_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

/**
 * Read the saved view state until it answers, then put it back with the task
 * tabs opened meanwhile added on top, and resume saving. Retries for the life of
 * the renderer: giving up would mean either never saving or overwriting.
 */
async function retrySavedViewState(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const delay = SAVED_VIEW_STATE_RETRY_MS[Math.min(attempt, SAVED_VIEW_STATE_RETRY_MS.length - 1)]
    await new Promise((resolve) => setTimeout(resolve, delay))
    let value: string | null | undefined
    try {
      value = await getTrpcClient().settings.get.query({ key: 'viewState' })
    } catch {
      continue
    }
    const openedMeanwhile = useTabStore
      .getState()
      .tabs.flatMap((t) => (t.type === 'task' ? [t.taskId] : []))
    applySavedViewState(value)
    _persistenceBlocked = false
    startTabSync()
    const open = new Set(
      useTabStore.getState().tabs.flatMap((t) => (t.type === 'task' ? [t.taskId] : []))
    )
    for (const taskId of openedMeanwhile) {
      if (!open.has(taskId)) useTabStore.getState().openTaskInBackground(taskId)
    }
    return
  }
}

// A task's outer tab can be closed while its agent keeps running — closing a
// tab only drops it from `viewState`, it doesn't touch `terminal_tabs.agent_state`
// (see tab-flags.ts). So the persisted tab list alone can miss live sessions on
// boot. Reopen those as background tabs (no focus steal) so the existing
// `agentState` resume path on `TerminalStarter` picks them back up. Best-effort:
// a failed fetch here must not block boot.
async function restoreActiveSessionTabs(): Promise<void> {
  try {
    const activeIds = await getTrpcClient().taskTerminals.listAutoRestoreTasks.query()
    if (activeIds.length === 0) return
    const openIds = new Set(
      useTabStore
        .getState()
        .tabs.filter((t): t is Extract<Tab, { type: 'task' }> => t.type === 'task')
        .map((t) => t.taskId)
    )
    for (const taskId of activeIds) {
      if (!openIds.has(taskId)) useTabStore.getState().openTaskInBackground(taskId)
    }
  } catch {
    /* best-effort — a missed auto-restore just leaves the task's Start gate showing */
  }
}

export const tabStoreReady: Promise<void> = Promise.resolve()

// Debounced persistence — subscribe to tab/index/project changes and save
let _debounceTimer: ReturnType<typeof setTimeout> | null = null
let _inflightWrite: Promise<unknown> = Promise.resolve()
let _persistenceStopped = false
/** True while the saved view state has not been read yet (see loadTabStoreState). */
let _persistenceBlocked = false

/**
 * Stop persisting `viewState` for the rest of this renderer's life: drop the pending
 * debounced write and resolve once any write already on the wire has landed. For a
 * caller about to wipe the DB and reload (the e2e `resetApp`): without it, a tab change
 * made just before the wipe is written AFTER it, and the reload restores a deleted task
 * as the active tab.
 */
export async function stopViewStatePersistence(): Promise<void> {
  _persistenceStopped = true
  // Nor change any hub's open tabs: a window that stops saving its layout (a test's
  // teardown) must not close tabs elsewhere as it empties.
  _stopTabSync?.()
  _stopTabSync = null
  if (_debounceTimer) clearTimeout(_debounceTimer)
  _debounceTimer = null
  await _inflightWrite.catch(() => {
    // Only waiting for the write to settle here, not handling its failure.
  })
}

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
    treeShowTags: state.treeShowTags,
    treeShowBlockedBadge: state.treeShowBlockedBadge,
    treeGroupBy: state.treeGroupBy,
    treeOrderBy: state.treeOrderBy,
    treeOrderDir: state.treeOrderDir,
    treeGroupTemporary: state.treeGroupTemporary,
    treeGroupBlocked: state.treeGroupBlocked,
    treeGroupPinned: state.treeGroupPinned,
    treeShowEmptyGroups: state.treeShowEmptyGroups,
    treeOpenProjects: state.treeOpenProjects,
    treeShowAllProjects: state.treeShowAllProjects,
    treeLensGroup: state.treeLensGroup,
    treeLensLook: state.treeLensLook,
    treeNeedsYou: state.treeNeedsYou,
    treeAccordionOpen: state.treeAccordionOpen,
    lenses: state.lenses,
    activeLensId: state.activeLensId,
    sidebarHubOrder: state.sidebarHubOrder,
    explodeOrder: state.explodeOrder,
    explodeMinimized: state.explodeMinimized,
    taskHeaderPanelMode: state.taskHeaderPanelMode,
    taskHeaderPanelAlign: state.taskHeaderPanelAlign,
    taskHeaderTitleAlign: state.taskHeaderTitleAlign,
    projectLastActiveTab: state.projectLastActiveTab,
    closedTabs: state.closedTabs,
    openTabsSync: state.openTabsSync
  }),
  (slice) => {
    if (!useTabStore.getState().isLoaded || _persistenceStopped || _persistenceBlocked) return
    if (_debounceTimer) clearTimeout(_debounceTimer)
    _debounceTimer = setTimeout(() => {
      _debounceTimer = null
      _inflightWrite = getTrpcClient().settings.set.mutate({
        key: 'viewState',
        value: JSON.stringify(slice)
      })
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

// Warm-process gate: push this window's per-project open-task-tab counts to main so it
// keeps exactly one warm agent shell ready per project that has ≥1 open tab. Full snapshot
// each time (idempotent on the main side), debounced to coalesce rapid tab churn.
let _warmDebounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * This window's open-task-tab counts per project, grouped by the hub that owns
 * each project — or `null` when they cannot be computed yet.
 *
 * Multi-hub: a project's warm shell must be pre-spawned on the hub that OWNS it,
 * so counts are grouped by owning hub and each hub is pushed its own slice. The
 * project→hub map rides `_taskLookup.projects[].hubId` (App fills it); absent →
 * default hub, so single-hub pushes exactly one snapshot = byte-identical.
 *
 * `null` while restored task tabs exist but the task lookup has not loaded yet
 * (renderer boot or reload): counts computed then are all zero, and the hub would
 * tear down every warm agent only to boot them all again a moment later, when
 * the lookup lands and re-fires the push.
 */
export function computeWarmTabCounts(
  tabs: Tab[],
  lookup: TaskLookup
): Map<string | undefined, Record<string, number>> | null {
  if (lookup.tasks.length === 0 && tabs.some((tab) => tab.type === 'task')) return null
  const hubOfProject = new Map(lookup.projects.map((p) => [p.id, p.hubId]))
  const countsByHub = new Map<string | undefined, Record<string, number>>()
  for (const tab of tabs) {
    if (tab.type !== 'task') continue
    const projectId = lookup.tasks.find((t) => t.id === tab.taskId)?.project_id
    if (!projectId) continue
    const hubId = hubOfProject.get(projectId)
    const counts = countsByHub.get(hubId) ?? {}
    counts[projectId] = (counts[projectId] ?? 0) + 1
    countsByHub.set(hubId, counts)
  }
  return countsByHub
}

const WARM_PATH = 'pty.warmSetProjectTabCounts'

/**
 * Push each hub its slice of {@link computeWarmTabCounts}. A hub this connection may
 * not drive the warm pool on (a web session, #164: its scope gate refuses the call)
 * is skipped — warm shells only serve `pty.create`, which that session cannot call.
 */
export async function pushWarmTabCounts(
  countsByHub: Map<string | undefined, Record<string, number>>,
  defaultClient: TabsStateTrpcClient,
  hubClientOf: (hubId: string) => TabsStateTrpcClient | null
): Promise<void> {
  const push = async (client: TabsStateTrpcClient, counts: Record<string, number>) => {
    if (!(await hubAllows(client, WARM_PATH))) return
    await client.pty.warmSetProjectTabCounts.mutate({ counts }).catch(() => {
      // Warm-pool hint only: a hub that is down just misses this snapshot, and the
      // next tab change re-pushes the full one.
    })
  }
  // Push every hub that has open tabs; also push an EMPTY snapshot to hubs that had
  // counts before but no longer do is unnecessary — main is idempotent per-window
  // and each hub only tracks its own projects.
  const pushes = [...countsByHub].map(([hubId, counts]) =>
    push((hubId && hubClientOf(hubId)) || defaultClient, counts)
  )
  // No open task tabs at all → clear the default hub's counts (preserves the prior
  // single-hub behavior of pushing an empty snapshot). Losing it only leaves a stale
  // warm hint until the next tab change.
  if (countsByHub.size === 0) pushes.push(push(defaultClient, {}))
  await Promise.all(pushes)
}

useTabStore.subscribe(
  (state) => ({ tabs: state.tabs, _taskLookup: state._taskLookup }),
  ({ tabs, _taskLookup }) => {
    if (typeof window === 'undefined') return
    const countsByHub = computeWarmTabCounts(tabs, _taskLookup)
    if (!countsByHub) return
    if (_warmDebounceTimer) clearTimeout(_warmDebounceTimer)
    _warmDebounceTimer = setTimeout(() => {
      // getTrpcClient throws until initTrpcClient runs (main.tsx boot). The only
      // firing that can land that early is the module-scope hydration push, whose
      // counts are empty (no _taskLookup yet) — safe to drop; the next tab change
      // re-pushes the full snapshot.
      let defaultClient: TabsStateTrpcClient
      try {
        defaultClient = getTrpcClient()
      } catch {
        return /* tRPC client not ready (boot) */
      }
      void pushWarmTabCounts(countsByHub, defaultClient, (id) => getHubClient(id)?.client ?? null)
    }, 150)
  },
  { equalityFn: shallow }
)
