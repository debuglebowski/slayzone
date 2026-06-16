import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useSubscription } from '@slayzone/transport/client'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import type { Task } from '@slayzone/task/shared'
import { track } from '@slayzone/telemetry/client'

export interface UseSubTasksReturn {
  subTasks: Task[]
  createSubTask: (params: {
    projectId: string
    title: string
    status: string
  }) => Promise<Task | null>
  updateSubTask: (subId: string, updates: Record<string, unknown>) => Promise<void>
  deleteSubTask: (subId: string) => Promise<void>
  handleDragEnd: (event: DragEndEvent) => void
}

export function useSubTasks(
  parentId: string | null | undefined,
  initialSubTasks?: Task[]
): UseSubTasksReturn {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  // Subtasks are query-backed. (They used to live in local `useState` fed ONLY
  // by a fire-and-forget subscription refetch, so a plain `invalidateQueries()`
  // — e.g. __slayzone_refreshData or an external CLI/MCP write — could never
  // reload them and they raced on mount.) A real `useQuery` reloads on mount,
  // on any matching invalidation, and lets optimistic edits land via setQueryData.
  const subTasksQuery = useQuery(
    trpc.task.getSubTasks.queryOptions(
      { parentId: parentId ?? '' },
      { enabled: !!parentId, initialData: parentId ? initialSubTasks : undefined }
    )
  )
  const subTasks = subTasksQuery.data ?? []

  const createMutation = useMutation(trpc.task.create.mutationOptions())
  const updateMutation = useMutation(trpc.task.update.mutationOptions())
  const deleteMutation = useMutation(trpc.task.delete.mutationOptions())
  const reorderMutation = useMutation(trpc.task.reorder.mutationOptions())

  // Re-fetch subtasks on external changes (CLI, MCP, bulk ops). Mirrors the
  // legacy `app.onTasksChanged` IPC listener via the `tasks-changed` subscription.
  useSubscription(
    trpc.notify.onTasksChanged.subscriptionOptions(undefined, {
      enabled: !!parentId,
      onData: () => {
        if (!parentId) return
        void queryClient.invalidateQueries(trpc.task.getSubTasks.queryFilter({ parentId }))
      }
    })
  )

  const createSubTask = useCallback(
    async (params: { projectId: string; title: string; status: string }): Promise<Task | null> => {
      if (!parentId) return null
      const sub = await createMutation.mutateAsync({
        projectId: params.projectId,
        title: params.title,
        parentId,
        status: params.status
      })
      if (sub) {
        queryClient.setQueryData<Task[]>(trpc.task.getSubTasks.queryKey({ parentId }), (prev) => [
          ...(prev ?? []),
          sub
        ])
        track('subtask_created')
      }
      return sub
    },
    [parentId]
  )

  const updateSubTask = useCallback(
    async (subId: string, updates: Record<string, unknown>): Promise<void> => {
      const updated = await updateMutation.mutateAsync({ id: subId, ...updates })
      if (updated && parentId) {
        queryClient.setQueryData<Task[]>(trpc.task.getSubTasks.queryKey({ parentId }), (prev) =>
          (prev ?? []).map((s) => (s.id === subId ? updated : s))
        )
      }
    },
    [parentId]
  )

  const deleteSubTask = useCallback(
    async (subId: string): Promise<void> => {
      await deleteMutation.mutateAsync({ id: subId })
      if (parentId) {
        queryClient.setQueryData<Task[]>(trpc.task.getSubTasks.queryKey({ parentId }), (prev) =>
          (prev ?? []).filter((s) => s.id !== subId)
        )
      }
    },
    [parentId]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event
      if (!over || active.id === over.id || !parentId) return
      queryClient.setQueryData<Task[]>(trpc.task.getSubTasks.queryKey({ parentId }), (prev) => {
        const list = prev ?? []
        const oldIndex = list.findIndex((s) => s.id === active.id)
        const newIndex = list.findIndex((s) => s.id === over.id)
        const reordered = arrayMove(list, oldIndex, newIndex)
        void reorderMutation.mutateAsync({ taskIds: reordered.map((t) => t.id) })
        return reordered
      })
    },
    [parentId]
  )

  return { subTasks, createSubTask, updateSubTask, deleteSubTask, handleDragEnd }
}
