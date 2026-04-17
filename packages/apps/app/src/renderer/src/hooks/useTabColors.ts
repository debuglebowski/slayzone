import { useMemo } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tab } from '@slayzone/settings'
import { WORKTREE_COLORS, hashStr } from '@slayzone/ui'

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
    const byProject = new Map<string, { taskId: string; worktreePath: string }[]>()
    for (const tab of tabs) {
      if (tab.type !== 'task') continue
      const task = tasks.find((t) => t.id === tab.taskId)
      if (!task?.project_id) continue
      if (!task.worktree_path) continue
      const group = byProject.get(task.project_id) ?? []
      group.push({ taskId: tab.taskId, worktreePath: task.worktree_path })
      byProject.set(task.project_id, group)
    }
    for (const entries of byProject.values()) {
      const distinctPaths = [...new Set(entries.map((e) => e.worktreePath))]
      const pathToColor = new Map<string, string>()
      const usedIndices = new Set<number>()
      for (const path of distinctPaths) {
        let idx = hashStr(path) % WORKTREE_COLORS.length
        while (usedIndices.has(idx) && usedIndices.size < WORKTREE_COLORS.length) idx = (idx + 1) % WORKTREE_COLORS.length
        usedIndices.add(idx)
        pathToColor.set(path, WORKTREE_COLORS[idx])
      }
      for (const entry of entries) {
        map.set(entry.taskId, pathToColor.get(entry.worktreePath)!)
      }
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
