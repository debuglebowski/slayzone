import { useMemo } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tab } from '@slayzone/settings'

export function useTabColors(
  tabs: Tab[],
  tasks: Task[],
  projects: Project[],
  colorTintsEnabled: boolean
) {
  const taskProjectColors = useMemo(() => {
    const map = new Map<string, string>()
    if (!colorTintsEnabled) return map
    for (const tab of tabs) {
      if (tab.type !== 'task') continue
      const task = tasks.find((t) => t.id === tab.taskId)
      if (!task?.project_id) continue
      const project = projects.find((p) => p.id === task.project_id)
      if (project?.color) map.set(tab.taskId, project.color)
    }
    return map
  }, [tabs, tasks, projects, colorTintsEnabled])

  const taskWorktreeColors = useMemo(() => {
    const map = new Map<string, string>()
    for (const tab of tabs) {
      if (tab.type !== 'task') continue
      const task = tasks.find((t) => t.id === tab.taskId)
      if (task?.worktree_color) map.set(tab.taskId, task.worktree_color)
    }
    return map
  }, [tabs, tasks])

  const tabCycleOrder = useMemo(() => {
    const homeIndex = tabs.findIndex((tab) => tab.type === 'home')
    const taskIndexes = tabs
      .map((tab, index) => (tab.type === 'task' ? index : -1))
      .filter((index) => index >= 0)
    const order: number[] = []
    if (homeIndex >= 0) order.push(homeIndex)
    order.push(...taskIndexes)
    return order
  }, [tabs])

  return { taskProjectColors, taskWorktreeColors, tabCycleOrder }
}
