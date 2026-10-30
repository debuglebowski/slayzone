/**
 * A task's artifacts and folders, live: the procedures desktop's panel loads
 * (`artifacts.getByTask`, `artifacts.foldersGetByTask`), loaded again whenever the hub
 * says the task changed (`notify.onTasksChanged` naming it, or naming no task: "anything
 * may have changed"; a hub older than the payload sends nothing at all, read the same) —
 * the signal desktop refreshes the panel on, sent by every artifact write. Must render
 * inside the task's hub scope.
 */
import type { TasksChangedEvent } from '@slayzone/task-contracts'
import type { ArtifactFolder, TaskArtifact } from '@slayzone/task-contracts/types'
import { useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '../trpc'

/** Whether a tasks-changed event may have changed this task. */
export function touchesTask(event: TasksChangedEvent | null | undefined, taskId: string): boolean {
  return !event?.taskIds || event.taskIds.includes(taskId)
}

export interface TaskArtifacts {
  /** Undefined until both lists load. */
  artifacts: TaskArtifact[] | undefined
  folders: ArtifactFolder[] | undefined
  pending: boolean
  /** Why loading failed; null = it didn't. */
  error: string | null
  refreshing: boolean
  refresh: () => void
}

/** Reloads the task's artifact lists when the hub says the task changed. */
export function useTaskArtifactsLive(taskId: string): void {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  useSubscription(
    trpc.notify.onTasksChanged.subscriptionOptions(undefined, {
      onData: (event) => {
        if (!touchesTask(event, taskId)) return
        void queryClient.invalidateQueries(trpc.artifacts.getByTask.queryFilter({ taskId }))
        void queryClient.invalidateQueries(trpc.artifacts.foldersGetByTask.queryFilter({ taskId }))
        void queryClient.invalidateQueries(trpc.artifacts.get.queryFilter())
      }
    })
  )
}

export function useTaskArtifacts(taskId: string): TaskArtifacts {
  const trpc = useTRPC()
  const artifactsQ = useQuery(trpc.artifacts.getByTask.queryOptions({ taskId }))
  const foldersQ = useQuery(trpc.artifacts.foldersGetByTask.queryOptions({ taskId }))
  useTaskArtifactsLive(taskId)
  const failed = artifactsQ.error ?? foldersQ.error
  const ready = artifactsQ.data !== undefined && foldersQ.data !== undefined
  return {
    artifacts: ready ? artifactsQ.data : undefined,
    folders: ready ? foldersQ.data : undefined,
    pending: artifactsQ.isPending || foldersQ.isPending,
    error: failed ? failed.message : null,
    refreshing: artifactsQ.isRefetching || foldersQ.isRefetching,
    refresh: () => {
      void artifactsQ.refetch()
      void foldersQ.refetch()
    }
  }
}
