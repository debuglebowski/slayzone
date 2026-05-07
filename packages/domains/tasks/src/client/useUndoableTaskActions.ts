import { useCallback, useRef } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import { toast, type UndoableAction } from '@slayzone/ui'

interface UndoAPI {
  push: (action: UndoableAction) => void
  undo: () => Promise<string | undefined>
}

interface TaskMutations {
  tasks: Task[]
  updateTask: (task: Task | null | undefined) => void
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>
  archiveTask: (taskId: string) => Promise<void>
  archiveTasks: (taskIds: string[]) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  bulkDelete: (taskIds: string[]) => Promise<void>
  contextMenuUpdate: (taskId: string, updates: Partial<Task>) => Promise<void>
  bulkContextMenuUpdate: (taskIds: string[], updates: Partial<Task>) => Promise<void>
}

/**
 * Wraps task mutations with undo support.
 * Returns drop-in replacements that push onto the undo stack and show toast.
 */
export function useUndoableTaskActions(mutations: TaskMutations, undo: UndoAPI) {
  const {
    updateTask,
    setTasks,
    archiveTask: rawArchive,
    archiveTasks: rawArchiveMany,
    deleteTask: rawDelete,
    bulkDelete: rawBulkDelete,
    contextMenuUpdate: rawContextMenuUpdate,
    bulkContextMenuUpdate: rawBulkContextMenuUpdate,
  } = mutations

  // Ref avoids adding `tasks` to useCallback deps — keeps function references stable
  const tasksRef = useRef(mutations.tasks)
  tasksRef.current = mutations.tasks

  const contextMenuUpdate = useCallback(
    async (taskId: string, updates: Partial<Task>) => {
      const task = tasksRef.current.find((t) => t.id === taskId)
      if (!task) return rawContextMenuUpdate(taskId, updates)

      // Capture only the fields being changed
      const prev: Partial<Task> = {}
      for (const key of Object.keys(updates) as (keyof Task)[]) {
        ;(prev as Record<string, unknown>)[key] = task[key]
      }

      await rawContextMenuUpdate(taskId, updates)

      const desc = updates.status
        ? `Changed "${task.title}" → ${updates.status}`
        : updates.is_blocked !== undefined
          ? `${updates.is_blocked ? 'Blocked' : 'Unblocked'} "${task.title}"`
          : `Updated "${task.title}"`

      undo.push({
        label: desc,
        undo: () => rawContextMenuUpdate(taskId, prev),
        redo: () => rawContextMenuUpdate(taskId, updates)
      })
      toast(desc, {
        action: { label: 'Undo', onClick: () => void undo.undo() }
      })
    },
    [rawContextMenuUpdate, undo]
  )

  const archiveTask = useCallback(
    async (taskId: string) => {
      const task = tasksRef.current.find((t) => t.id === taskId)
      await rawArchive(taskId)
      if (!task) return

      undo.push({
        label: `Archived "${task.title}"`,
        undo: async () => {
          const restored = await getTrpcVanillaClient().task.unarchive.mutate({ id: taskId })
          if (restored) updateTask(restored)
        },
        redo: () => rawArchive(taskId)
      })
      toast(`Archived "${task.title}"`, {
        action: { label: 'Undo', onClick: () => void undo.undo() }
      })
    },
    [rawArchive, updateTask, undo]
  )

  const archiveTasks = useCallback(
    async (taskIds: string[]) => {
      const archived = tasksRef.current.filter((t) => taskIds.includes(t.id))
      await rawArchiveMany(taskIds)
      if (archived.length === 0) return

      undo.push({
        label: `Archived ${archived.length} tasks`,
        undo: async () => {
          for (const id of taskIds) {
            const restored = await getTrpcVanillaClient().task.unarchive.mutate({ id: id })
            if (restored) updateTask(restored)
          }
        },
        redo: () => rawArchiveMany(taskIds)
      })
      toast(`Archived ${archived.length} tasks`, {
        action: { label: 'Undo', onClick: () => void undo.undo() }
      })
    },
    [rawArchiveMany, updateTask, undo]
  )

  const deleteTask = useCallback(
    async (taskId: string) => {
      const task = tasksRef.current.find((t) => t.id === taskId)
      await rawDelete(taskId)
      if (!task) return

      undo.push({
        label: `Deleted "${task.title}"`,
        undo: async () => {
          const restored = await getTrpcVanillaClient().task.restore.mutate({ id: taskId })
          if (restored) setTasks((prev) => [restored, ...prev])
        },
        redo: () => rawDelete(taskId)
      })
      toast(`Deleted "${task.title}"`, {
        action: { label: 'Undo', onClick: () => void undo.undo() }
      })
    },
    [rawDelete, setTasks, undo]
  )

  const bulkContextMenuUpdate = useCallback(
    async (taskIds: string[], updates: Partial<Task>) => {
      if (taskIds.length === 0) return
      // Per-id snapshot of changed fields for restore
      const prevById = new Map<string, Partial<Task>>()
      for (const id of taskIds) {
        const t = tasksRef.current.find((x) => x.id === id)
        if (!t) continue
        const prev: Partial<Task> = {}
        for (const key of Object.keys(updates) as (keyof Task)[]) {
          ;(prev as Record<string, unknown>)[key] = t[key]
        }
        prevById.set(id, prev)
      }

      await rawBulkContextMenuUpdate(taskIds, updates)

      const desc = updates.status
        ? `Changed ${taskIds.length} tasks → ${updates.status}`
        : updates.is_blocked !== undefined
          ? `${updates.is_blocked ? 'Blocked' : 'Unblocked'} ${taskIds.length} tasks`
          : `Updated ${taskIds.length} tasks`

      undo.push({
        label: desc,
        undo: async () => {
          // Per-id restore — heterogeneous, so apply individually
          for (const [id, prev] of prevById) {
            await rawContextMenuUpdate(id, prev)
          }
        },
        redo: () => rawBulkContextMenuUpdate(taskIds, updates),
      })
      toast(desc, {
        action: { label: 'Undo', onClick: () => void undo.undo() },
      })
    },
    [rawBulkContextMenuUpdate, rawContextMenuUpdate, undo]
  )

  const bulkDelete = useCallback(
    async (taskIds: string[]) => {
      if (taskIds.length === 0) return
      const removed = tasksRef.current.filter((t) => taskIds.includes(t.id))
      await rawBulkDelete(taskIds)
      if (removed.length === 0) return

      undo.push({
        label: `Deleted ${removed.length} tasks`,
        undo: async () => {
          for (const id of taskIds) {
            const restored = await getTrpcVanillaClient().task.restore.mutate({ id: id })
            if (restored) setTasks((prev) => [restored, ...prev])
          }
        },
        redo: () => rawBulkDelete(taskIds),
      })
      toast(`Deleted ${removed.length} tasks`, {
        action: { label: 'Undo', onClick: () => void undo.undo() },
      })
    },
    [rawBulkDelete, setTasks, undo]
  )

  return { contextMenuUpdate, archiveTask, archiveTasks, deleteTask, bulkContextMenuUpdate, bulkDelete }
}
