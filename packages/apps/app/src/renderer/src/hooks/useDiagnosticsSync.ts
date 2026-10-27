import { useEffect, useRef } from 'react'
import { recordDiagnosticsTimeline, updateDiagnosticsContext } from '@/lib/diagnosticsClient'
import type { Tab, ActiveView } from '@slayzone/settings'

export function useDiagnosticsSync({
  tabs,
  activeTabIndex,
  activeView,
  selectedProjectId,
  projects,
  taskCount,
  displayTaskCount,
  projectPathMissing
}: {
  tabs: Tab[]
  activeTabIndex: number
  activeView: ActiveView
  selectedProjectId: string
  projects: { id: string; name: string }[]
  taskCount: number
  displayTaskCount: number
  /** The SELECTED project's path check: null while it has not answered yet. */
  projectPathMissing: boolean | null
}): void {
  useEffect(() => {
    const activeTab = tabs[activeTabIndex]
    updateDiagnosticsContext({
      activeTabIndex,
      activeTabType: activeTab?.type ?? 'unknown',
      activeTaskId: activeTab?.type === 'task' ? activeTab.taskId : null,
      openTaskTabs: tabs.filter((t) => t.type === 'task').length,
      selectedProjectId,
      selectedProjectName: projects.find((p) => p.id === selectedProjectId)?.name ?? null,
      taskCount,
      visibleTaskCount: displayTaskCount,
      projectPathMissing
    })
  }, [
    activeTabIndex,
    tabs,
    selectedProjectId,
    projects,
    taskCount,
    displayTaskCount,
    projectPathMissing
  ])

  const previousProjectRef = useRef(selectedProjectId)
  useEffect(() => {
    if (previousProjectRef.current === selectedProjectId) return
    recordDiagnosticsTimeline('project_changed', {
      from: previousProjectRef.current,
      to: selectedProjectId
    })
    previousProjectRef.current = selectedProjectId
  }, [selectedProjectId])

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
}
