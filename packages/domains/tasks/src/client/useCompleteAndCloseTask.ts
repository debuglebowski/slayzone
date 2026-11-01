import { useCallback } from 'react'
import { useTabStore } from '@slayzone/tabs-state'
import { getHubIdForTask } from '@slayzone/transport/client'
import { getClientForHub, useTRPCClient } from './trpc'
import { getDoneStatus, type Project } from '@slayzone/projects-contracts'
import type { Task } from '@slayzone/task-contracts'
import { toast } from '@slayzone/ui'
import type { CloseTaskTabOptions } from './useCloseTaskTab'
import type { UndoAPI } from './useUndoableTaskActions'

interface CompleteAndCloseDeps {
  tasks: Task[]
  projects: Project[]
  /** Upsert one task into board state (useTasksData's updateTask). */
  updateTask: (task: Task | null | undefined) => void
  /** Close the view, optionally waiting for a pending write. */
  closeTabByTaskId: (taskId: string, opts?: CloseTaskTabOptions) => Promise<void>
  openTask: (taskId: string) => void
}

/**
 * "Complete & Close Tab" (⌘⇧D): mark a task done in its project's completed
 * column and close its tab — undoably. Closing the view preserves the task and
 * its running processes, including scratch terminals. Writes reach its owning hub.
 *
 * Optimistic both ways: the done status and the tab close land in the caller's
 * synchronous turn — one render — so the open tab never shows the done state on
 * its way out; undo likewise flips status + tab back at once. The hub writes
 * follow; a failed one puts the UI back to where it was.
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
      const hubId = getHubIdForTask(taskId)
      const client = () => getClientForHub(hubId, trpcClient)

      const complete = (): Promise<void> => {
        const wasOpen = useTabStore
          .getState()
          .tabs.some((t) => t.type === 'task' && t.taskId === taskId)
        const write = client().task.update.mutate({
          id: taskId,
          status: doneStatus
        })
        updateTask({ ...task, status: doneStatus })
        // Await the status write while closing the view immediately.
        const closed = closeTabByTaskId(taskId, { after: write })
        return write.then(
          async (updated) => {
            if (updated) updateTask(updated)
            await closed
          },
          (err: unknown) => {
            closed.catch(() => undefined)
            updateTask(task)
            if (wasOpen) openTask(taskId)
            throw err
          }
        )
      }

      const completed = await complete().then(
        () => true,
        (err: unknown) => {
          toast.error(
            `Couldn't complete "${task.title}": ${err instanceof Error ? err.message : String(err)}`
          )
          return false
        }
      )
      if (!completed) return
      // Nothing to put back: the status didn't change and the close deleted nothing.
      if (prevStatus === doneStatus) return

      const label = `Completed "${task.title}"`
      // Undo restores the old status and opens the preserved task immediately.
      const revert = (): Promise<void> => {
        const restored = { ...task, status: prevStatus }
        const write = client().task.update.mutate({ id: taskId, status: prevStatus })
        updateTask(restored)
        // The tab store reads title/temporary-ness from its lookup when opening; a
        // restored temporary task isn't in it until the board sync catches up.
        const lookup = useTabStore.getState()._taskLookup
        if (!lookup.tasks.some((t) => t.id === taskId)) {
          useTabStore.setState({
            _taskLookup: { ...lookup, tasks: [restored, ...lookup.tasks] }
          })
        }
        openTask(taskId)
        return write.then(
          (reverted) => {
            if (reverted) updateTask(reverted)
          },
          (err: unknown) => {
            updateTask({ ...task, status: doneStatus })
            void closeTabByTaskId(taskId).catch(() => undefined)
            toast.error(
              `Couldn't undo "${task.title}": ${err instanceof Error ? err.message : String(err)}`
            )
            throw err
          }
        )
      }

      undo.push({
        label,
        undo: revert,
        redo: complete
      })
      toast(label, {
        action: { label: 'Undo', onClick: () => void undo.undo() }
      })
    },
    [tasks, projects, updateTask, closeTabByTaskId, openTask, undo, trpcClient]
  )
}
