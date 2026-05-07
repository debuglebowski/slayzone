import { useState, useEffect, useCallback } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
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
  const [subTasks, setSubTasks] = useState<Task[]>(initialSubTasks ?? [])

  // Re-fetch subtasks on external changes (CLI, MCP)
  useEffect(() => {
    if (!parentId) return
    const refresh = (): void => {
      getTrpcVanillaClient().task.getSubTasks.query({ parentId: parentId }).then(setSubTasks).catch(() => {})
    }
    const _sub = getTrpcVanillaClient().task.onChanged.subscribe(undefined, { onData: () => refresh() }); const cleanup = () => _sub.unsubscribe()
    return () => { cleanup?.() }
  }, [parentId])

  const createSubTask = useCallback(async (params: { projectId: string; title: string; status: string }): Promise<Task | null> => {
    if (!parentId) return null
    const sub = await getTrpcVanillaClient().task.create.mutate({
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
  }, [parentId])

  const updateSubTask = useCallback(async (subId: string, updates: Record<string, unknown>): Promise<void> => {
    const updated = await getTrpcVanillaClient().task.update.mutate({ id: subId, ...updates })
    if (updated) {
      setSubTasks(prev => prev.map(s => s.id === subId ? updated : s))
    }
  }, [])

  const deleteSubTask = useCallback(async (subId: string): Promise<void> => {
    await getTrpcVanillaClient().task.delete.mutate({ id: subId })
    setSubTasks(prev => prev.filter(s => s.id !== subId))
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setSubTasks(prev => {
      const oldIndex = prev.findIndex(s => s.id === active.id)
      const newIndex = prev.findIndex(s => s.id === over.id)
      const reordered = arrayMove(prev, oldIndex, newIndex)
      getTrpcVanillaClient().task.reorder.mutate({ taskIds: reordered.map(t => t.id) })
      return reordered
    })
  }, [])

  return { subTasks, createSubTask, updateSubTask, deleteSubTask, handleDragEnd }
}
