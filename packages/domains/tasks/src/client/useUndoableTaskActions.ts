import { useCallback, useEffect, useRef } from 'react'
import { getHubIdForTask, useHubOwnershipStore } from '@slayzone/transport/client'
import { getClientForHub, useTRPCClient } from './trpc'
import type { Task } from '@slayzone/task-contracts'
import { toast, type UndoableAction } from '@slayzone/ui'

export interface UndoAPI {
  push: (action: UndoableAction) => void
  undo: () => Promise<string | undefined>
}

interface TaskMutations {
  tasks: Task[]
  updateTask: (task: Task | null | undefined) => void
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>
  archiveTask: (taskId: string) => Promise<void>
  /** Bulk ops resolve to the ids that succeeded (they fan out per hub). */
  archiveTasks: (taskIds: string[]) => Promise<string[]>
  deleteTask: (taskId: string) => Promise<void>
  bulkDelete: (taskIds: string[]) => Promise<string[]>
  contextMenuUpdate: (taskId: string, updates: Partial<Task>) => Promise<void>
  bulkContextMenuUpdate: (taskIds: string[], updates: Partial<Task>) => Promise<string[]>
}

/**
 * Each task's owning hub, read BEFORE an archive/delete: once the task leaves the
 * board its owner can no longer be looked up, and undo must reach that hub.
 */
function captureOwners(taskIds: string[]): Map<string, string | undefined> {
  return new Map(taskIds.map((id) => [id, getHubIdForTask(id)]))
}

/** Re-note a restored task's owner so a redo (which looks owners up) routes there. */
function noteOwner(taskId: string, hubId: string | undefined): void {
  if (hubId) useHubOwnershipStore.getState().noteTaskHub(taskId, hubId)
}

/**
 * Wraps task mutations with undo support.
 * Returns drop-in replacements that push onto the undo stack and show toast
 * (same signatures — the bulk ones still resolve to the ids that succeeded).
 */
export function useUndoableTaskActions(mutations: TaskMutations, undo: UndoAPI) {
  const trpcClient = useTRPCClient()
  const {
    updateTask,
    setTasks,
    archiveTask: rawArchive,
    archiveTasks: rawArchiveMany,
    deleteTask: rawDelete,
    bulkDelete: rawBulkDelete,
    contextMenuUpdate: rawContextMenuUpdate,
    bulkContextMenuUpdate: rawBulkContextMenuUpdate
  } = mutations

  // The actions take their undo snapshot from the latest board without depending on
  // it: a `tasks` dep would hand every consumer (each open task tab) new functions
  // on every board change. The undo API's functions are stable; the object is not.
  const tasksRef = useRef(mutations.tasks)
  useEffect(() => {
    tasksRef.current = mutations.tasks
  })
  const { push: pushUndo, undo: runUndo } = undo

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

      pushUndo({
        label: desc,
        undo: () => rawContextMenuUpdate(taskId, prev),
        redo: () => rawContextMenuUpdate(taskId, updates)
      })
      toast(desc, {
        action: { label: 'Undo', onClick: () => void runUndo() }
      })
    },
    [rawContextMenuUpdate, pushUndo, runUndo]
  )

  const archiveTask = useCallback(
    async (taskId: string) => {
      const task = tasksRef.current.find((t) => t.id === taskId)
      const hubId = getHubIdForTask(taskId)
      await rawArchive(taskId)
      if (!task) return

      pushUndo({
        label: `Archived "${task.title}"`,
        undo: async () => {
          const restored = await getClientForHub(hubId, trpcClient).task.unarchive.mutate({
            id: taskId
          })
          if (restored) {
            noteOwner(taskId, hubId)
            updateTask(restored)
          }
        },
        redo: () => rawArchive(taskId)
      })
      toast(`Archived "${task.title}"`, {
        action: { label: 'Undo', onClick: () => void runUndo() }
      })
    },
    [rawArchive, updateTask, pushUndo, runUndo, trpcClient]
  )

  const archiveTasks = useCallback(
    async (taskIds: string[]) => {
      const owners = captureOwners(taskIds)
      const archivedIds = await rawArchiveMany(taskIds)
      if (archivedIds.length === 0) return archivedIds

      pushUndo({
        label: `Archived ${archivedIds.length} tasks`,
        undo: async () => {
          for (const id of archivedIds) {
            const hubId = owners.get(id)
            const restored = await getClientForHub(hubId, trpcClient).task.unarchive.mutate({ id })
            if (restored) {
              noteOwner(id, hubId)
              updateTask(restored)
            }
          }
        },
        redo: async () => {
          await rawArchiveMany(archivedIds)
        }
      })
      toast(`Archived ${archivedIds.length} tasks`, {
        action: { label: 'Undo', onClick: () => void runUndo() }
      })
      return archivedIds
    },
    [rawArchiveMany, updateTask, pushUndo, runUndo, trpcClient]
  )

  const deleteTask = useCallback(
    async (taskId: string) => {
      const task = tasksRef.current.find((t) => t.id === taskId)
      const hubId = getHubIdForTask(taskId)
      await rawDelete(taskId)
      if (!task) return

      pushUndo({
        label: `Deleted "${task.title}"`,
        undo: async () => {
          const restored = await getClientForHub(hubId, trpcClient).task.restore.mutate({
            id: taskId
          })
          if (restored) {
            noteOwner(taskId, hubId)
            setTasks((prev) => [restored, ...prev])
          }
        },
        redo: () => rawDelete(taskId)
      })
      toast(`Deleted "${task.title}"`, {
        action: { label: 'Undo', onClick: () => void runUndo() }
      })
    },
    [rawDelete, setTasks, pushUndo, runUndo, trpcClient]
  )

  const bulkContextMenuUpdate = useCallback(
    async (taskIds: string[], updates: Partial<Task>) => {
      if (taskIds.length === 0) return []
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

      const updatedIds = await rawBulkContextMenuUpdate(taskIds, updates)
      if (updatedIds.length === 0) return updatedIds

      const desc = updates.status
        ? `Changed ${updatedIds.length} tasks → ${updates.status}`
        : updates.is_blocked !== undefined
          ? `${updates.is_blocked ? 'Blocked' : 'Unblocked'} ${updatedIds.length} tasks`
          : `Updated ${updatedIds.length} tasks`

      pushUndo({
        label: desc,
        undo: async () => {
          // Per-id restore — heterogeneous, so apply individually
          for (const id of updatedIds) {
            const prev = prevById.get(id)
            if (prev) await rawContextMenuUpdate(id, prev)
          }
        },
        redo: async () => {
          await rawBulkContextMenuUpdate(updatedIds, updates)
        }
      })
      toast(desc, {
        action: { label: 'Undo', onClick: () => void runUndo() }
      })
      return updatedIds
    },
    [rawBulkContextMenuUpdate, rawContextMenuUpdate, pushUndo, runUndo]
  )

  const bulkDelete = useCallback(
    async (taskIds: string[]) => {
      if (taskIds.length === 0) return []
      const owners = captureOwners(taskIds)
      const deletedIds = await rawBulkDelete(taskIds)
      if (deletedIds.length === 0) return deletedIds

      pushUndo({
        label: `Deleted ${deletedIds.length} tasks`,
        undo: async () => {
          for (const id of deletedIds) {
            const hubId = owners.get(id)
            const restored = await getClientForHub(hubId, trpcClient).task.restore.mutate({ id })
            if (restored) {
              noteOwner(id, hubId)
              setTasks((prev) => [restored, ...prev])
            }
          }
        },
        redo: async () => {
          await rawBulkDelete(deletedIds)
        }
      })
      toast(`Deleted ${deletedIds.length} tasks`, {
        action: { label: 'Undo', onClick: () => void runUndo() }
      })
      return deletedIds
    },
    [rawBulkDelete, setTasks, pushUndo, runUndo, trpcClient]
  )

  return {
    contextMenuUpdate,
    archiveTask,
    archiveTasks,
    deleteTask,
    bulkContextMenuUpdate,
    bulkDelete
  }
}
