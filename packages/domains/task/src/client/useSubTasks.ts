import { useState, useCallback } from 'react'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import type { Task } from '@slayzone/task/shared'
import { track } from '@slayzone/telemetry/client'

export interface UseSubTasksReturn {
  subTasks: Task[]
  createSubTask: (params: { projectId: string; title: string; status: string }) => Promise<Task | null>
  updateSubTask: (subId: string, updates: Record<string, unknown>) => Promise<void>
  deleteSubTask: (subId: string) => Promise<void>
  handleDragEnd: (event: DragEndEvent) => void
}

export function useSubTasks(
  parentId: string | null | undefined,
  initialSubTasks?: Task[]
): UseSubTasksReturn {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [subTasks, setSubTasks] = useState<Task[]>(initialSubTasks ?? [])

  // Re-fetch subtasks on external changes (CLI, MCP)
  useSubscription(
    trpc.task.onChanged.subscriptionOptions(undefined, {
      enabled: !!parentId,
      onData: () => {
        if (!parentId) return
        trpcClient.task.getSubTasks.query({ parentId }).then(setSubTasks).catch(() => {})
      },
    }),
  )

  const createSubTask = useCallback(async (params: { projectId: string; title: string; status: string }): Promise<Task | null> => {
    if (!parentId) return null
    const sub = await trpcClient.task.create.mutate({
      projectId: params.projectId,
      title: params.title,
      parentId,
      status: params.status,
    })
    if (sub) {
      setSubTasks(prev => [...prev, sub])
      track('subtask_created')
    }
    return sub
  }, [parentId, trpcClient])

  const updateSubTask = useCallback(async (subId: string, updates: Record<string, unknown>): Promise<void> => {
    const updated = await trpcClient.task.update.mutate({ id: subId, ...updates })
    if (updated) {
      setSubTasks(prev => prev.map(s => s.id === subId ? updated : s))
    }
  }, [trpcClient])

  const deleteSubTask = useCallback(async (subId: string): Promise<void> => {
    await trpcClient.task.delete.mutate({ id: subId })
    setSubTasks(prev => prev.filter(s => s.id !== subId))
  }, [trpcClient])

  const handleDragEnd = useCallback((event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setSubTasks(prev => {
      const oldIndex = prev.findIndex(s => s.id === active.id)
      const newIndex = prev.findIndex(s => s.id === over.id)
      const reordered = arrayMove(prev, oldIndex, newIndex)
      trpcClient.task.reorder.mutate({ taskIds: reordered.map(t => t.id) })
      return reordered
    })
  }, [trpcClient])

  return { subTasks, createSubTask, updateSubTask, deleteSubTask, handleDragEnd }
}
