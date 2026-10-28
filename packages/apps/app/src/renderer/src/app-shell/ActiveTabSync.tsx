import { memo, useEffect, useRef } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task-contracts'
import { useTabStore, type ActiveView, type Tab } from '@slayzone/tabs-state'
import { useDiagnosticsSync } from '@/hooks/useDiagnosticsSync'
import { useTabPageViews } from '@/hooks/useTabLifecycle'

interface ActiveTabSyncProps {
  tabs: Tab[]
  tasksMap: Map<string, Task>
  selectedProjectId: string
  activeView: ActiveView
  projects: { id: string; name: string }[]
  taskCount: number
  displayTaskCount: number
  /** The selected project's own path check (null while it runs) — for diagnostics. */
  selectedProjectPathMissing: boolean | null
}

/**
 * Side effects of a tab switch, isolated from App: this renders nothing and is the
 * only part of the shell subscribed to the active tab index, so a switch re-runs it
 * instead of App and every hook App calls.
 */
export const ActiveTabSync = memo(function ActiveTabSync({
  tabs,
  tasksMap,
  selectedProjectId,
  activeView,
  projects,
  taskCount,
  displayTaskCount,
  selectedProjectPathMissing
}: ActiveTabSyncProps): null {
  const trpcClient = useTRPCClient()
  const activeTabIndex = useTabStore((s) => s.activeTabIndex)
  const activeTab = tabs[activeTabIndex]
  const activeTaskId = activeTab?.type === 'task' ? activeTab.taskId : null

  useTabPageViews(tabs, activeTabIndex)
  useDiagnosticsSync({
    tabs,
    activeTabIndex,
    activeView,
    selectedProjectId,
    projects,
    taskCount,
    displayTaskCount,
    projectPathMissing: selectedProjectPathMissing
  })

  // Broadcast primary's active task ID so secondary windows in "Follow current tab" mode swap
  useEffect(() => {
    void trpcClient.app.taskWindows.setPrimaryActive.mutate({
      taskId: activeTaskId
    })
  }, [activeTaskId, trpcClient])

  // Mark a task "read" (clear needs_attention) when the user *navigates into* it —
  // i.e. it becomes the active tab. Deliberately NOT cleared while the task merely
  // stays active: that is what lets "Mark as unread" stick even though the task is
  // on screen. Two refs handle the timing:
  //  - activatedTaskRef: id of the current activation. A change => a fresh open.
  //  - readConsumedRef: the id we've already issued the read-clear for this
  //    activation. Ensures a late tasksMap update (task data arriving after the tab
  //    switch) still clears exactly once, and a tasksMap update caused by a later
  //    "Mark as unread" does NOT re-clear it.
  const activatedTaskRef = useRef<string | null>(null)
  const readConsumedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeTaskId) {
      activatedTaskRef.current = null
      return
    }
    // Fresh activation: reset the once-per-activation read guard.
    if (activeTaskId !== activatedTaskRef.current) {
      activatedTaskRef.current = activeTaskId
      readConsumedRef.current = null
    }
    if (readConsumedRef.current === activeTaskId) return
    const task = tasksMap.get(activeTaskId)
    if (!task) return // data not loaded yet — wait for the next tasksMap update
    readConsumedRef.current = activeTaskId
    if (task.needs_attention) {
      void trpcClient.task.update.mutate({ id: activeTaskId, needsAttention: false }).catch(() => {
        // Clearing the unread dot is cosmetic — a failed write just means the
        // dot survives until the next activation, which retries.
      })
    }
  }, [activeTaskId, tasksMap, trpcClient])

  // Auto-switch project when activating a task tab
  const activeTaskProjectId = activeTaskId ? tasksMap.get(activeTaskId)?.project_id : undefined
  useEffect(() => {
    if (activeTaskProjectId && activeTaskProjectId !== selectedProjectId)
      useTabStore.getState().setSelectedProjectId(activeTaskProjectId)
  }, [activeTaskProjectId, selectedProjectId])

  return null
})
