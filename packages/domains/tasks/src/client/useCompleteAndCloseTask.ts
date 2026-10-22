import { useCallback } from 'react'
import { useTabStore } from '@slayzone/settings/client'
import {
  getClientForHub,
  getHubIdForTask,
  useHubOwnershipStore,
  useTRPCClient
} from '@slayzone/transport/client'
import { getDoneStatus, type Project } from '@slayzone/projects/shared'
import type { Task } from '@slayzone/task/shared'
import { toast } from '@slayzone/ui'
import type { UndoAPI } from './useUndoableTaskActions'

interface CompleteAndCloseDeps {
  tasks: Task[]
  projects: Project[]
  /** Upsert one task into board state (useTasksData's updateTask). */
  updateTask: (task: Task | null | undefined) => void
  /** The shell's tab close (useCloseTaskTab): deletes a temporary task, resolving once it has. */
  closeTabByTaskId: (taskId: string) => Promise<void>
  openTask: (taskId: string) => void
}

/**
 * "Complete & Close Tab" (⌘⇧D): mark a task done in its project's completed
 * column and close its tab — undoably. Closing a temporary task's tab deletes the
 * task, so undo restores it before reverting the status and reopening the tab.
 * Every write goes to the hub that owns the task, captured up front because a
 * deleted task's owner can no longer be looked up from the board.
 */
export function useCompleteAndCloseTask(deps: CompleteAndCloseDeps, undo: UndoAPI) {
  const trpcClient = useTRPCClient()
  const { tasks, projects, updateTask, closeTabByTaskId, openTask } = deps

  return useCallback(
    async (taskId: string): Promise<void> => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return
      const project = projects.find((p) => p.id === task.project_id)
      const doneStatus = getDoneStatus(project?.columns_config)
      const prevStatus = task.status
      const isTemporary = !!task.is_temporary
      const hubId = getHubIdForTask(taskId)
      const client = () => getClientForHub(hubId, trpcClient)

      const complete = async (): Promise<void> => {
        const updated = await client().task.update.mutate({ id: taskId, status: doneStatus })
        updateTask(updated ?? { ...task, status: doneStatus })
        await closeTabByTaskId(taskId)
      }

      await complete()
      // Nothing to put back: the status didn't change and the close deleted nothing.
      if (prevStatus === doneStatus && !isTemporary) return

      const label = `Completed "${task.title}"`
      undo.push({
        label,
        undo: async () => {
          if (isTemporary) {
            await client().task.restore.mutate({ id: taskId })
            if (hubId) useHubOwnershipStore.getState().noteTaskHub(taskId, hubId)
          }
          const reverted = await client().task.update.mutate({ id: taskId, status: prevStatus })
          const restored = reverted ?? { ...task, status: prevStatus }
          updateTask(restored)
          // The tab store reads title/temporary-ness from its lookup when opening; a
          // restored temporary task isn't in it until the board sync catches up.
          const lookup = useTabStore.getState()._taskLookup
          if (!lookup.tasks.some((t) => t.id === taskId)) {
            useTabStore.setState({ _taskLookup: { ...lookup, tasks: [restored, ...lookup.tasks] } })
          }
          openTask(taskId)
        },
        redo: complete
      })
      toast(label, { action: { label: 'Undo', onClick: () => void undo.undo() } })
    },
    [tasks, projects, updateTask, closeTabByTaskId, openTask, undo, trpcClient]
  )
}
