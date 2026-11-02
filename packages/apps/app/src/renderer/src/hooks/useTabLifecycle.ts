import { useEffect, useRef } from 'react'
import type { Task } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
import { useTabStore, type Tab } from '@slayzone/tabs-state'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import { useTrack } from '@slayzone/telemetry/client'
import { getClientForHub } from '../trpc'
import { useHubOwnershipStore } from '@slayzone/transport/client'
import { recordDiagnosticsTimeline } from '@/lib/diagnosticsClient'

type TaskTab = Extract<Tab, { type: 'task' }>

/** A hub's task count must be at least this before halving it counts as a drop. */
const TASK_DROP_MIN = 20

/**
 * Whether a missing tab is ready for a deletion check. Only
 * its own hub can say so: each hub's list arrives on its own, so one hub
 * answering first proves nothing about another's tasks (that closed every tab of
 * the slower hub). A hub that never answers (offline) never closes its tabs; a
 * hub removed from the app does. A tab whose hub is not known yet waits for all.
 */
function canCheckMissing(
  tab: TaskTab,
  hubs: { loaded: ReadonlySet<string>; registered: ReadonlySet<string> }
): boolean {
  if (tab.hubId === undefined) return [...hubs.registered].every((id) => hubs.loaded.has(id))
  return !hubs.registered.has(tab.hubId) || hubs.loaded.has(tab.hubId)
}

/**
 * The live row of a task on the first of `hubIds` that has it, or null when every
 * one of them says it is gone (deleted, or NOT_FOUND — how authenticated hubs
 * report a missing or inaccessible id). Rejects when any hub cannot answer:
 * unreachable is not deleted.
 */
async function findLiveTask(
  taskId: string,
  hubIds: readonly string[]
): Promise<{ task: Task; hubId: string } | null> {
  const rows = await Promise.all(
    hubIds.map((hubId) =>
      getClientForHub(hubId)
        .task.get.query({ id: taskId })
        .catch((error: unknown) => {
          if (error && typeof error === 'object' && 'data' in error) {
            const data = error.data
            if (data && typeof data === 'object' && 'code' in data && data.code === 'NOT_FOUND')
              return null
          }
          throw error
        })
    )
  )
  const index = rows.findIndex((row) => row && !row.deleted_at)
  return index >= 0 ? { task: rows[index] as Task, hubId: hubIds[index] } : null
}

/** Close only the tab instances checked, preserving a surviving active tab. */
function closeConfirmedTabs(removed: ReadonlySet<TaskTab>): void {
  useTabStore.setState((store) => {
    const removedTabs = store.tabs.filter(
      (tab): tab is TaskTab => tab.type === 'task' && removed.has(tab)
    )
    if (removedTabs.length === 0) return store
    const tabs = store.tabs.filter((tab) => tab.type !== 'task' || !removed.has(tab))
    const active = tabs.indexOf(store.tabs[store.activeTabIndex])
    return {
      tabs,
      activeTabIndex:
        active >= 0 ? active : Math.max(0, Math.min(store.activeTabIndex, tabs.length - 1)),
      closedTabs: [...store.closedTabs, ...removedTabs].slice(-20)
    }
  })
}

export function useTabLifecycle({
  tasks,
  projects,
  tabs,
  setTerminalFocusRequests,
  hubIdByProject,
  hubIdByTask,
  defaultHubId,
  registeredHubIds,
  loadedHubIds,
  onTaskRecovered
}: {
  tasks: Task[]
  projects: Project[]
  tabs: Tab[]
  setTerminalFocusRequests: React.Dispatch<React.SetStateAction<Record<string, number>>>
  /** Multi-hub: project→hub / task→hub origin maps (empty when single-hub). */
  hubIdByProject?: Map<string, string>
  hubIdByTask?: Map<string, string>
  /** The hub a task with no entry in `hubIdByTask` belongs to. */
  defaultHubId: string
  /** Every hub the app is connected to (the registry), default hub included. */
  registeredHubIds: ReadonlySet<string>
  /** The hubs whose task list has arrived at least once. */
  loadedHubIds: ReadonlySet<string>
  /** Restore a verified live row omitted by an older board response. */
  onTaskRecovered: (task: Task) => void
}): void {
  // Sync task/project data into tab store for worktree grouping + temp task
  // detection. Multi-hub: annotate each project with its owning hub so the
  // warm-pool feed routes counts to the right hub (absent → default hub).
  useEffect(() => {
    const annotatedProjects = hubIdByProject
      ? projects.map((p) => ({ ...p, hubId: hubIdByProject.get(p.id) }))
      : projects
    useTabStore.setState({
      _taskLookup: { tasks, projects: annotatedProjects }
    })
  }, [tasks, projects, hubIdByProject])

  // Evict cache entries when task tabs close (prevent memory leaks). Multi-hub:
  // evict the (taskId, hubId) slot so a remote task's cached detail is freed.
  const prevTabsRef = useRef(tabs)
  useEffect(() => {
    const prev = prevTabsRef.current
    prevTabsRef.current = tabs
    for (const tab of prev) {
      if (tab.type !== 'task') continue
      if (!tabs.some((t) => t.type === 'task' && t.taskId === tab.taskId)) {
        taskDetailCache.evict('taskDetail', tab.taskId, hubIdByTask?.get(tab.taskId))
      }
    }
  }, [tabs, hubIdByTask])

  // Record a sharp drop in a loaded hub's task count (the 2026-10-31 wipe: the
  // merged list fell to one hub's tasks), with every hub's counts before/after.
  const hubCountsRef = useRef<Record<string, number> | null>(null)
  useEffect(() => {
    const after: Record<string, number> = {}
    for (const hubId of loadedHubIds) after[hubId] = 0
    for (const task of tasks) {
      const hubId = hubIdByTask?.get(task.id) ?? defaultHubId
      if (hubId in after) after[hubId]++
    }
    const before = hubCountsRef.current
    hubCountsRef.current = after
    if (!before) return
    const shrank = Object.entries(before).some(
      ([hubId, count]) => count >= TASK_DROP_MIN && (after[hubId] ?? 0) < count / 2
    )
    if (!shrank) return
    recordDiagnosticsTimeline('task_list_shrank', {
      before,
      after,
      loaded: [...loadedHubIds],
      registered: [...registeredHubIds]
    })
  }, [tasks, hubIdByTask, defaultHubId, loadedHubIds, registeredHubIds])

  // Sync tab titles/status/hub and remove tabs for deleted tasks.
  useEffect(() => {
    if (loadedHubIds.size === 0) return
    const taskIds = new Set(tasks.map((t) => t.id))
    const hubs = { loaded: loadedHubIds, registered: registeredHubIds }
    const store = useTabStore.getState()
    const prev = store.tabs
    const missing = prev.filter(
      (tab): tab is TaskTab =>
        tab.type === 'task' && !taskIds.has(tab.taskId) && canCheckMissing(tab, hubs)
    )
    const updated = prev.map((tab) => {
      if (tab.type !== 'task') return tab
      const task = tasks.find((t) => t.id === tab.taskId)
      if (task) {
        const isSubTask = !!task.parent_id
        const isTemporary = !!task.is_temporary
        const hubId = hubIdByTask?.get(task.id) ?? defaultHubId
        if (
          task.title !== tab.title ||
          task.status !== tab.status ||
          isSubTask !== tab.isSubTask ||
          isTemporary !== tab.isTemporary ||
          hubId !== tab.hubId
        ) {
          return {
            ...tab,
            title: task.title,
            status: task.status,
            isSubTask,
            isTemporary,
            hubId
          }
        }
      }
      return tab
    })
    useTabStore.setState({ tabs: updated })

    // A hub removed from the registry cannot own visible tabs any more.
    const removedHubTabs = new Set(
      missing.filter((tab) => tab.hubId !== undefined && !registeredHubIds.has(tab.hubId))
    )
    for (const tab of removedHubTabs) {
      recordDiagnosticsTimeline('tab_auto_closed', {
        taskId: tab.taskId,
        hubId: tab.hubId,
        reason: 'hub_removed'
      })
    }
    closeConfirmedTabs(removedHubTabs)

    // Board reads may have started before a create or restore committed. Their
    // absence is not proof of deletion: check the current row on its owning hub
    // before changing (and persisting) the open-tab list. A failed/offline read
    // preserves the tab. Legacy tabs with no hub need every hub to confirm.
    // The recorded hub is asked first; when it says the task is gone, every other
    // hub is asked too — a tab tagged with the wrong hub must not close a task that
    // lives elsewhere. Any hub that cannot answer keeps the tab.
    let cancelled = false
    for (const tab of missing) {
      if (removedHubTabs.has(tab)) continue
      const owners = tab.hubId === undefined ? [...registeredHubIds] : [tab.hubId]
      const others = [...registeredHubIds].filter((hubId) => !owners.includes(hubId))
      void findLiveTask(tab.taskId, owners)
        .then((found) => found ?? findLiveTask(tab.taskId, others))
        .then((found) => {
          if (cancelled || !useTabStore.getState().tabs.includes(tab)) return
          if (found) {
            useHubOwnershipStore.getState().noteTaskHub(found.task.id, found.hubId)
            onTaskRecovered(found.task)
            return
          }
          // A later board/restore may already have brought the row back.
          if (useTabStore.getState()._taskLookup.tasks.some((task) => task.id === tab.taskId))
            return
          recordDiagnosticsTimeline('tab_auto_closed', {
            taskId: tab.taskId,
            hubId: tab.hubId,
            reason: 'confirmed_gone',
            askedHubs: [...owners, ...others]
          })
          closeConfirmedTabs(new Set([tab]))
        })
        .catch(() => {
          // Unreachable or unauthenticated is not deleted.
        })
    }
    return () => {
      cancelled = true
    }
  }, [tasks, hubIdByTask, defaultHubId, registeredHubIds, loadedHubIds, onTaskRecovered])

  // Drop stale focus requests for tasks that no longer exist.
  useEffect(() => {
    const taskIds = new Set(tasks.map((t) => t.id))
    setTerminalFocusRequests((prev) => {
      let changed = false
      const next: Record<string, number> = {}
      for (const [id, requestId] of Object.entries(prev)) {
        if (taskIds.has(id)) next[id] = requestId
        else changed = true
      }
      return changed ? next : prev
    })
  }, [tasks, setTerminalFocusRequests])
}

/**
 * Track a page view per tab switch. Separate from useTabLifecycle because it needs
 * the active index: call it from a component that re-renders on a switch, not App.
 */
export function useTabPageViews(tabs: Tab[], activeTabIndex: number): void {
  const { track, trackTask } = useTrack()
  const prevTabIndexRef = useRef(-1)
  useEffect(() => {
    if (activeTabIndex === prevTabIndexRef.current) return
    prevTabIndexRef.current = activeTabIndex
    const tab = tabs[activeTabIndex]
    if (!tab) return
    if (tab.type === 'task') {
      // Names the task: its hub decides (a hub with telemetry off withholds it).
      trackTask(tab.taskId, '$pageview', {
        $current_url: `/task/${tab.taskId}`,
        page: 'task',
        task_id: tab.taskId
      })
    } else {
      track('$pageview', { $current_url: `/${tab.type}`, page: tab.type })
    }
  }, [activeTabIndex, tabs, track, trackTask])
}
