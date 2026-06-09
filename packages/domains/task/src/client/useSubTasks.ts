import { useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
  const [subTasks, setSubTasks] = useState<Task[]>(initialSubTasks ?? [])

  const createMutation = useMutation(trpc.task.create.mutationOptions())
  const updateMutation = useMutation(trpc.task.update.mutationOptions())
  const deleteMutation = useMutation(trpc.task.delete.mutationOptions())
  const reorderMutation = useMutation(trpc.task.reorder.mutationOptions())

  // Re-fetch subtasks on external changes (CLI, MCP). Mirrors the legacy
  // `app.onTasksChanged` IPC listener via the `tasks-changed` subscription.
  useSubscription(
    trpc.notify.onTasksChanged.subscriptionOptions(undefined, {
      enabled: !!parentId,
      onData: () => {
        if (!parentId) return
        void queryClient
          .fetchQuery(trpc.task.getSubTasks.queryOptions({ parentId }))
          .then(setSubTasks)
          .catch(() => {})
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
        setSubTasks((prev) => [...prev, sub])
        track('subtask_created')
      }
      return sub
    },
    [parentId]
  )

  const updateSubTask = useCallback(
    async (subId: string, updates: Record<string, unknown>): Promise<void> => {
      const updated = await updateMutation.mutateAsync({ id: subId, ...updates })
      if (updated) {
        setSubTasks((prev) => prev.map((s) => (s.id === subId ? updated : s)))
      }
    },
    []
  )

  const deleteSubTask = useCallback(
    async (subId: string): Promise<void> => {
      await deleteMutation.mutateAsync({ id: subId })
      setSubTasks((prev) => prev.filter((s) => s.id !== subId))
    },
    []
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      setSubTasks((prev) => {
        const oldIndex = prev.findIndex((s) => s.id === active.id)
        const newIndex = prev.findIndex((s) => s.id === over.id)
        const reordered = arrayMove(prev, oldIndex, newIndex)
        void reorderMutation.mutateAsync({ taskIds: reordered.map((t) => t.id) })
        return reordered
      })
    },
    []
  )

  return { subTasks, createSubTask, updateSubTask, deleteSubTask, handleDragEnd }
}
