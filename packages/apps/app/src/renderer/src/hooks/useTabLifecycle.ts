import { useEffect, useRef } from 'react'
import type { Task } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
import { useTabStore, type Tab } from '@slayzone/tabs-state'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import { track } from '@slayzone/telemetry/client'

type TaskTab = Extract<Tab, { type: 'task' }>

/**
 * Whether a tab's task is gone for good, given it is not in the task list. Only
 * its own hub can say so: each hub's list arrives on its own, so one hub
 * answering first proves nothing about another's tasks (that closed every tab of
 * the slower hub). A hub that never answers (offline) never closes its tabs; a
 * hub removed from the app does. A tab whose hub is not known yet waits for all.
 */
function isGone(
  tab: TaskTab,
  hubs: { loaded: ReadonlySet<string>; registered: ReadonlySet<string> }
): boolean {
  if (tab.hubId === undefined) return [...hubs.registered].every((id) => hubs.loaded.has(id))
  return !hubs.registered.has(tab.hubId) || hubs.loaded.has(tab.hubId)
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
  loadedHubIds
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
}): void {
  // Sync task/project data into tab store for worktree grouping + temp task
  // detection. Multi-hub: annotate each project with its owning hub so the
  // warm-pool feed routes counts to the right hub (absent → default hub).
  useEffect(() => {
    const annotatedProjects = hubIdByProject
      ? projects.map((p) => ({ ...p, hubId: hubIdByProject.get(p.id) }))
      : projects
    useTabStore.setState({ _taskLookup: { tasks, projects: annotatedProjects } })
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

  // Sync tab titles/status/hub and remove tabs for deleted tasks.
  useEffect(() => {
    if (loadedHubIds.size === 0) return
    const taskIds = new Set(tasks.map((t) => t.id))
    const hubs = { loaded: loadedHubIds, registered: registeredHubIds }
    const store = useTabStore.getState()
    const prev = store.tabs
    const removedTabs = prev.filter(
      (tab): tab is TaskTab => tab.type === 'task' && !taskIds.has(tab.taskId) && isGone(tab, hubs)
    )
    const removed = new Set(removedTabs)
    if (removedTabs.length > 0) {
      const newClosed = [...store.closedTabs, ...removedTabs]
      while (newClosed.length > 20) newClosed.shift()
      useTabStore.setState({ closedTabs: newClosed })
    }
    const filtered = prev.filter((tab) => tab.type !== 'task' || !removed.has(tab))
    const newActive =
      filtered.length < prev.length
        ? Math.min(store.activeTabIndex, filtered.length - 1)
        : store.activeTabIndex
    const updated = filtered.map((tab) => {
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
          return { ...tab, title: task.title, status: task.status, isSubTask, isTemporary, hubId }
        }
      }
      return tab
    })
    useTabStore.setState({ tabs: updated, activeTabIndex: newActive })
  }, [tasks, hubIdByTask, defaultHubId, registeredHubIds, loadedHubIds])

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
  const prevTabIndexRef = useRef(-1)
  useEffect(() => {
    if (activeTabIndex === prevTabIndexRef.current) return
    prevTabIndexRef.current = activeTabIndex
    const tab = tabs[activeTabIndex]
    if (!tab) return
    if (tab.type === 'task') {
      track('$pageview', { $current_url: `/task/${tab.taskId}`, page: 'task', task_id: tab.taskId })
    } else {
      track('$pageview', { $current_url: `/${tab.type}`, page: tab.type })
    }
  }, [activeTabIndex, tabs])
}
