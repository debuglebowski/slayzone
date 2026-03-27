import { useState, useEffect, useCallback } from 'react'
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
      window.api.db.getSubTasks(parentId).then(setSubTasks).catch(() => {})
    }
    const cleanup = window.api?.app?.onTasksChanged?.(refresh)
    return () => { cleanup?.() }
  }, [parentId])

  const createSubTask = useCallback(async (params: { projectId: string; title: string; status: string }): Promise<Task | null> => {
    if (!parentId) return null
    const sub = await window.api.db.createTask({
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
    const updated = await window.api.db.updateTask({ id: subId, ...updates })
    if (updated) {
      setSubTasks(prev => prev.map(s => s.id === subId ? updated : s))
    }
  }, [])

  const deleteSubTask = useCallback(async (subId: string): Promise<void> => {
    await window.api.db.deleteTask(subId)
    setSubTasks(prev => prev.filter(s => s.id !== subId))
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setSubTasks(prev => {
      const oldIndex = prev.findIndex(s => s.id === active.id)
      const newIndex = prev.findIndex(s => s.id === over.id)
      const reordered = arrayMove(prev, oldIndex, newIndex)
      window.api.db.reorderTasks(reordered.map(t => t.id))
      return reordered
    })
  }, [])

  return { subTasks, createSubTask, updateSubTask, deleteSubTask, handleDragEnd }
}
