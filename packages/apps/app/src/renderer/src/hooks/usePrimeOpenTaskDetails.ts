import { useEffect, useRef } from 'react'
import type { Project } from '@slayzone/projects-contracts'
import type { Tag } from '@slayzone/tags/shared'
import type { Task } from '@slayzone/task-contracts'
import type { Tab } from '@slayzone/tabs-state'
import { buildTaskDetailSnapshot, taskDetailCache } from '@slayzone/task/client/taskDetailCache'

export interface PrimeOpenTaskDetailsInput {
  tabs: readonly Tab[]
  tasks: readonly Task[]
  projects: readonly Project[]
  tags: readonly Tag[]
  taskTags: ReadonlyMap<string, readonly string[]>
  hubIdByTask: ReadonlyMap<string, string>
  defaultHubId: string
}

/**
 * Seed every open task tab's detail data from the board state already loaded.
 *
 * Opening a task does this (`guardTaskOpen`). Restored tabs did not: each hidden
 * pane fetched its detail through the idle queue, 4 at a time and ~5 sequential
 * hub/computer round trips each — 73 s for 67 tabs on 2026-11-11, and every
 * agent restore of those tabs waited for it. A primed pane hydrates from the
 * cache with no round trip.
 *
 * `prime` never clobbers, so a pane that already fetched keeps its data. A tab
 * whose task is not loaded yet (another hub still loading) is tried again when
 * the tasks change.
 */
export function usePrimeOpenTaskDetails(input: PrimeOpenTaskDetailsInput): void {
  const { tabs, tasks, projects, tags, taskTags, hubIdByTask, defaultHubId } = input
  const primed = useRef(new Set<string>())
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.type !== 'task' || primed.current.has(tab.taskId)) continue
      const snapshot = buildTaskDetailSnapshot(tab.taskId, {
        tasks,
        projects,
        tags,
        taskTagIds: taskTags.get(tab.taskId) ?? [],
        // Not known to be missing; the detail page probes its folder on mount.
        projectPathMissing: false
      })
      if (!snapshot) continue
      primed.current.add(tab.taskId)
      const hubId = hubIdByTask.get(tab.taskId) ?? defaultHubId
      taskDetailCache.prime('taskDetail', [tab.taskId, hubId], snapshot)
    }
  }, [tabs, tasks, projects, tags, taskTags, hubIdByTask, defaultHubId])
}
