import { useEffect, useRef } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { useTabStore, type Tab } from '@slayzone/settings'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import { track } from '@slayzone/telemetry/client'

type PtyContext = {
  subscribeExit: (sessionId: string, cb: (exitCode: number) => void) => () => void
}

export function useTabLifecycle({
  tasks,
  projects,
  tabs,
  activeTabIndex,
  setTasks,
  ptyContext,
  setTerminalFocusRequests
}: {
  tasks: Task[]
  projects: Project[]
  tabs: Tab[]
  activeTabIndex: number
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>
  ptyContext: PtyContext
  setTerminalFocusRequests: React.Dispatch<React.SetStateAction<Record<string, number>>>
}): void {
  // Sync task/project data into tab store for worktree grouping + temp task detection
  useEffect(() => {
    useTabStore.setState({ _taskLookup: { tasks, projects } })
  }, [tasks, projects])

  // Evict cache entries when task tabs close (prevent memory leaks).
  const prevTabsRef = useRef(tabs)
  useEffect(() => {
    const prev = prevTabsRef.current
    prevTabsRef.current = tabs
    for (const tab of prev) {
      if (tab.type !== 'task') continue
      if (!tabs.some((t) => t.type === 'task' && t.taskId === tab.taskId)) {
        taskDetailCache.evict('taskDetail', tab.taskId)
      }
    }
  }, [tabs])

  // Auto-close temporary task tabs when their main terminal exits.
  useEffect(() => {
    const temporaryTaskTabs = tabs.filter((tab): tab is Extract<typeof tab, { type: 'task' }> =>
      tab.type === 'task' && !!tab.isTemporary
    )
    const unsubscribes = temporaryTaskTabs.map((tab) => {
      const mainSessionId = `${tab.taskId}:${tab.taskId}`
      const subscribedMode = tasks.find((task) => task.id === tab.taskId)?.terminal_mode
      return ptyContext.subscribeExit(mainSessionId, (exitCode) => {
        if (exitCode !== 0) return
        const latestMode = tasks.find((task) => task.id === tab.taskId)?.terminal_mode
        if (subscribedMode && latestMode && subscribedMode !== latestMode) return
        void (async () => {
          // Skip auto-close when the PTY exit was triggered by a display-mode
          // switch (terminal → chat). setTabDisplayMode persists displayMode
          // before killing the PTY, so the row already reflects the new mode.
          const tabsList = await window.api.tabs.list(tab.taskId).catch(() => null)
          const mainTab = tabsList?.find((t) => t.isMain)
          if (mainTab?.displayMode === 'chat') return
          await window.api.db.deleteTask(tab.taskId).catch(() => {})
          setTasks((prev) => prev.filter((task) => task.id !== tab.taskId))
          useTabStore.getState().closeTabByTaskId(tab.taskId)
        })()
      })
    })

    return () => {
      unsubscribes.forEach((unsub) => unsub())
    }
  }, [tabs, tasks, ptyContext, setTasks])

  // Track whether task data has loaded at least once.
  const tasksLoadedRef = useRef(false)
  if (tasks.length > 0) tasksLoadedRef.current = true

  // Sync tab titles/status and remove tabs for deleted tasks.
  useEffect(() => {
    if (!tasksLoadedRef.current) return
    const taskIds = new Set(tasks.map((t) => t.id))
    const store = useTabStore.getState()
    const prev = store.tabs
    const removedTabs = prev.filter((tab): tab is Extract<Tab, { type: 'task' }> => tab.type === 'task' && !taskIds.has(tab.taskId))
    if (removedTabs.length > 0) {
      const newClosed = [...store.closedTabs, ...removedTabs]
      while (newClosed.length > 20) newClosed.shift()
      useTabStore.setState({ closedTabs: newClosed })
    }
    const filtered = prev.filter((tab) => tab.type !== 'task' || taskIds.has(tab.taskId))
    const newActive = filtered.length < prev.length ? Math.min(store.activeTabIndex, filtered.length - 1) : store.activeTabIndex
    const updated = filtered.map((tab) => {
      if (tab.type !== 'task') return tab
      const task = tasks.find((t) => t.id === tab.taskId)
      if (task) {
        const isSubTask = !!task.parent_id
        const isTemporary = !!task.is_temporary
        if (task.title !== tab.title || task.status !== tab.status || isSubTask !== tab.isSubTask || isTemporary !== tab.isTemporary) {
          return { ...tab, title: task.title, status: task.status, isSubTask, isTemporary }
        }
      }
      return tab
    })
    useTabStore.setState({ tabs: updated, activeTabIndex: newActive })
  }, [tasks])

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
  }, [tasks])

  // Startup cleanup: delete orphaned temporary tasks (no open tab)
  const didCleanupRef = useRef(false)
  useEffect(() => {
    if (didCleanupRef.current || tasks.length === 0) return
    didCleanupRef.current = true
    const openTabTaskIds = new Set(
      tabs.filter((t): t is Extract<typeof t, { type: 'task' }> => t.type === 'task').map((t) => t.taskId)
    )
    for (const task of tasks) {
      if (task.is_temporary && !openTabTaskIds.has(task.id)) {
        window.api.pty.kill(`${task.id}:${task.id}`)
        window.api.db.deleteTask(task.id)
        setTasks((prev) => prev.filter((t) => t.id !== task.id))
      }
    }
  }, [tasks, tabs, setTasks])

  // Track page views on tab switch
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
