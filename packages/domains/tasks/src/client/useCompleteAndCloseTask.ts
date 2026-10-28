import { useCallback } from 'react'
import { useTabStore } from '@slayzone/tabs-state'
import {
  getClientForHub,
  getHubIdForTask,
  useHubOwnershipStore,
  useTRPCClient
} from '@slayzone/transport/client'
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
  /** The shell's tab close (useCloseTaskTab): deletes a temporary task, resolving once it has. */
  closeTabByTaskId: (taskId: string, opts?: CloseTaskTabOptions) => Promise<void>
  openTask: (taskId: string) => void
}

/**
 * "Complete & Close Tab" (⌘⇧D): mark a task done in its project's completed
 * column and close its tab — undoably. Closing a temporary task's tab deletes the
 * task, so undo restores it on the hub before reverting its status there.
 * Every write goes to the hub that owns the task, captured up front because a
 * deleted task's owner can no longer be looked up from the board.
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
      const isTemporary = !!task.is_temporary
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
        // A temporary task's delete waits for the write (and is skipped if it fails).
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
      if (prevStatus === doneStatus && !isTemporary) return

      const label = `Completed "${task.title}"`
      // Mirror image of `complete`: the old status and the reopened tab land at once,
      // the hub writes follow. A temporary task's restore goes first on the hub (its
      // status write chains on it); its tab can open meanwhile — the detail load
      // reads soft-deleted rows. If a write fails, the task is completed and closed
      // again (closing a temporary task's tab re-deletes it).
      const revert = (): Promise<void> => {
        const restored = { ...task, status: prevStatus }
        if (isTemporary && hubId) useHubOwnershipStore.getState().noteTaskHub(taskId, hubId)
        const write = (
          isTemporary ? client().task.restore.mutate({ id: taskId }) : Promise.resolve()
        ).then(() => client().task.update.mutate({ id: taskId, status: prevStatus }))
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
