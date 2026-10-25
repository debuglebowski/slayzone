import { useMemo } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Tab } from '@slayzone/settings'
import { useTabStore } from '@slayzone/settings'

const identity = (i: number) => i

export function useVisibleTabs(tabs: Tab[], tasksMap: Map<string, Task>) {
  const selectedProjectId = useTabStore((s) => s.selectedProjectId)
  const projectScopedTabs = useTabStore((s) => s.projectScopedTabs)

  // Mapping: stable when tabs/project/scoping don't change. Deliberately blind to the
  // active tab: the caller (App) must not re-render on a tab switch.
  const { visibleTabs, toFullIndex, toVisibleIndex } = useMemo(() => {
    if (!projectScopedTabs || !selectedProjectId) {
      return { visibleTabs: tabs, toFullIndex: identity, toVisibleIndex: identity }
    }

    const visibleIndexes: number[] = []
    const filtered: Tab[] = []
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i]
      if (tab.type === 'home') {
        visibleIndexes.push(i)
        filtered.push(tab)
      } else if (tab.type === 'task') {
        const task = tasksMap.get(tab.taskId)
        if (task?.project_id === selectedProjectId) {
          visibleIndexes.push(i)
          filtered.push(tab)
        }
      }
    }

    const fullToVisible = new Map<number, number>()
    for (let v = 0; v < visibleIndexes.length; v++) {
      fullToVisible.set(visibleIndexes[v], v)
    }

    return {
      visibleTabs: filtered,
      toFullIndex: (visibleIdx: number) => visibleIndexes[visibleIdx] ?? 0,
      toVisibleIndex: (fullIdx: number) => fullToVisible.get(fullIdx) ?? -1
    }
  }, [tabs, selectedProjectId, projectScopedTabs, tasksMap])

  return { visibleTabs, toFullIndex, toVisibleIndex }
}

/**
 * The active tab's position among the visible tabs (0 when it is filtered out).
 * Subscribes to the active index — call it only in components that must re-render
 * on a tab switch.
 */
export function useVisibleActiveIndex(toVisibleIndex: (fullIndex: number) => number): number {
  const visibleActiveIndex = toVisibleIndex(useTabStore((s) => s.activeTabIndex))
  return visibleActiveIndex >= 0 ? visibleActiveIndex : 0
}
