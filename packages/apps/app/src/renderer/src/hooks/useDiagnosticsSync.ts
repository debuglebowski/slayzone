import { useEffect, useRef } from 'react'
import { recordDiagnosticsTimeline, updateDiagnosticsContext } from '@/lib/diagnosticsClient'
import type { Tab, ActiveView } from '@slayzone/settings'

export function useDiagnosticsSync({
  tabs,
  activeTabIndex,
  activeView,
  selectedProjectId,
  projects,
  tasks,
  displayTaskCount,
  notificationState,
  projectPathMissing
}: {
  tabs: Tab[]
  activeTabIndex: number
  activeView: ActiveView
  selectedProjectId: string
  projects: { id: string; name: string }[]
  tasks: { length: number }
  displayTaskCount: number
  notificationState: { isLocked: boolean; filterCurrentProject: boolean }
  projectPathMissing: boolean
}): void {
  // Context sync
  useEffect(() => {
    const activeTab = tabs[activeTabIndex]
    updateDiagnosticsContext({
      activeTabIndex,
      activeTabType: activeTab?.type ?? 'unknown',
      activeTaskId: activeTab?.type === 'task' ? activeTab.taskId : null,
      openTaskTabs: tabs.filter((t) => t.type === 'task').length,
      selectedProjectId,
      selectedProjectName: projects.find((p) => p.id === selectedProjectId)?.name ?? null,
      taskCount: tasks.length,
      visibleTaskCount: displayTaskCount,
      notificationPanelLocked: notificationState.isLocked,
      notificationFilterCurrentProject: notificationState.filterCurrentProject,
      projectPathMissing
    })
  }, [
    activeTabIndex,
    tabs,
    selectedProjectId,
    projects,
    tasks.length,
    displayTaskCount,
    notificationState.isLocked,
    notificationState.filterCurrentProject,
    projectPathMissing
  ])

  // Timeline: project changed
  const previousProjectRef = useRef(selectedProjectId)
  useEffect(() => {
    if (previousProjectRef.current === selectedProjectId) return
    recordDiagnosticsTimeline('project_changed', {
      from: previousProjectRef.current,
      to: selectedProjectId
    })
    previousProjectRef.current = selectedProjectId
  }, [selectedProjectId])

  // Timeline: tab changed
  const previousActiveTabRef = useRef('home')
  useEffect(() => {
    let nextTabKey: string
    if (activeView !== 'tabs') {
      nextTabKey = activeView
    } else {
      const activeTab = tabs[activeTabIndex]
      nextTabKey = activeTab?.type === 'task' ? `task:${activeTab.taskId}` : 'home'
    }
    if (previousActiveTabRef.current === nextTabKey) return
    recordDiagnosticsTimeline('tab_changed', {
      from: previousActiveTabRef.current,
      to: nextTabKey,
      activeTabIndex
    })
    previousActiveTabRef.current = nextTabKey
  }, [tabs, activeTabIndex, activeView])

  // Timeline: notification lock changed
  const previousNotificationLockedRef = useRef(notificationState.isLocked)
  useEffect(() => {
    if (previousNotificationLockedRef.current === notificationState.isLocked) return
    recordDiagnosticsTimeline('notification_lock_changed', {
      from: previousNotificationLockedRef.current,
      to: notificationState.isLocked
    })
    previousNotificationLockedRef.current = notificationState.isLocked
  }, [notificationState.isLocked])

  // Timeline: notification filter changed
  const previousNotificationProjectFilterRef = useRef(notificationState.filterCurrentProject)
  useEffect(() => {
    if (previousNotificationProjectFilterRef.current === notificationState.filterCurrentProject) return
    recordDiagnosticsTimeline('notification_filter_project_changed', {
      from: previousNotificationProjectFilterRef.current,
      to: notificationState.filterCurrentProject
    })
    previousNotificationProjectFilterRef.current = notificationState.filterCurrentProject
  }, [notificationState.filterCurrentProject])
}
