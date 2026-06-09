import { useState, useEffect, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import type { Task, TaskStatus } from '@slayzone/task/shared'
import type { Project, ProjectGroup, TopLevelEntryRef } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { GroupKey } from './kanban'

function hasTaskIdentity(task: Task | null | undefined): task is Task {
  return !!task && typeof task.id === 'string' && task.id.length > 0
}

/**
 * Maps a snake_case `Partial<Task>` patch to the camelCase fields accepted by
 * `updateTask` / `updateTasks`. Single source of truth for the context-menu
 * update paths — a field omitted here is silently dropped before it reaches
 * the DB, so every editable task field must be listed.
 */
function toUpdateTaskFields(updates: Partial<Task>) {
  return {
    title: updates.title,
    status: updates.status,
    priority: updates.priority,
    progress: updates.progress,
    projectId: updates.project_id,
    snoozedUntil: updates.snoozed_until,
    isBlocked: updates.is_blocked,
    blockedComment: updates.blocked_comment,
    needsAttention: updates.needs_attention
  }
}

interface UseTasksDataReturn {
  // Data
  tasks: Task[]
  projects: Project[]
  projectGroups: ProjectGroup[]
  tags: Tag[]
  taskTags: Map<string, string[]>
  blockedTaskIds: Set<string>

  // Setters (for dialog callbacks)
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>
  setProjectGroups: React.Dispatch<React.SetStateAction<ProjectGroup[]>>
  setTags: React.Dispatch<React.SetStateAction<Tag[]>>
  setTaskTags: React.Dispatch<React.SetStateAction<Map<string, string[]>>>

  // Task handlers
  updateTask: (task: Task | null | undefined) => void
  moveTask: (taskId: string, newColumnId: string, targetIndex: number, groupBy: GroupKey) => void
  bulkMove: (taskIds: string[], newColumnId: string, targetIndex: number, groupBy: GroupKey) => void
  reorderTasks: (taskIds: string[]) => void
  reparentTask: (taskId: string, newParentId: string | null, newSiblingTaskIds: string[]) => void
  bulkReparent: (taskIds: string[], newParentId: string | null, newSiblingTaskIds: string[]) => void
  archiveTask: (taskId: string) => Promise<void>
  archiveTasks: (taskIds: string[]) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  bulkDelete: (taskIds: string[]) => Promise<void>
  contextMenuUpdate: (taskId: string, updates: Partial<Task>) => Promise<void>
  bulkContextMenuUpdate: (taskIds: string[], updates: Partial<Task>) => Promise<void>
  setTaskPinned: (taskId: string, pinned: boolean) => void
  setTasksPinned: (taskIds: string[], pinned: boolean) => void
  setTaskCollapsed: (taskId: string, collapsed: boolean) => void
  reorderPinnedTasks: (taskIds: string[]) => void
  clearBlockers: (taskId: string) => Promise<void>

  // Project handlers
  updateProject: (project: Project) => void
  reorderProjects: (projectIds: string[]) => void
  deleteProject: (
    projectId: string,
    selectedProjectId: string,
    setSelectedProjectId: (id: string) => void
  ) => void

  // Project-group handlers (Discord folders / tree labels)
  createProjectGroup: (name?: string) => void
  createFolderWithProjects: (projectIds: string[]) => void
  renameProjectGroup: (id: string, name: string) => void
  deleteProjectGroup: (id: string) => void
  setGroupCollapsed: (id: string, collapsed: boolean) => void
  reorderTopLevel: (entries: TopLevelEntryRef[]) => void
  moveProjectToGroup: (projectId: string, groupId: string | null, targetIndex: number) => void
  reorderProjectsInGroup: (groupId: string, projectIds: string[]) => void
}

export function useTasksData(): UseTasksDataReturn {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()

  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [taskTags, setTaskTags] = useState<Map<string, string[]>>(new Map())
  const [blockedTaskIds, setBlockedTaskIds] = useState<Set<string>>(new Set())

  // Board data spine: declarative query is the source of truth; the useState
  // mirrors below stay so the many optimistic mutation handlers keep working
  // unchanged and consumers keep reading synchronous arrays.
  const boardQ = useQuery(trpc.task.loadBoardData.queryOptions(undefined, { staleTime: 30_000 }))

  // Boot timing: mark the board-load start once on mount (the query auto-fires
  // here). Paired with the end/dataReady marks below. `app.bootMark` has no
  // tRPC router, so it stays on the IPC bridge.
  useEffect(() => {
    performance.mark('sz:loadBoardData:start')
    window.api.app.bootMark?.('loadBoardData start')
  }, [])

  // Project groups loaded imperatively via the `projectGroups` tRPC router and
  // mirrored into `projectGroups` state (the many optimistic mutation handlers
  // below keep reading a synchronous array). The `__slayzone_refreshData` bridge
  // and the onTasksChanged subscription both re-run this loader alongside the
  // board query. Vanilla client (stable ref) — fire-and-forget, no hook deps churn.
  const loadGroups = useCallback(() => {
    return trpcClient.projectGroups.list.query().then((groups) => {
      setProjectGroups(groups as ProjectGroup[])
    })
  }, [trpcClient])

  // Seed the useState mirrors from the board query result.
  useEffect(() => {
    const d = boardQ.data
    if (!d) return
    setTasks(d.tasks as Task[])
    setProjects(d.projects as Project[])
    setTags(d.tags as Tag[])
    setTaskTags(new Map(Object.entries(d.taskTags)))
    setBlockedTaskIds(new Set(d.blockedTaskIds))
  }, [boardQ.data])

  // Initial groups load (mount-only; refresh paths re-run loadGroups directly).
  useEffect(() => {
    void loadGroups()
  }, [loadGroups])

  // Boot instrumentation: fire bootMark/dataReady once the board query first
  // lands, preserving the legacy single-shot signal. `app.bootMark`/`dataReady`
  // have no tRPC router, so they stay on the IPC bridge.
  useEffect(() => {
    if (boardQ.isPending) return
    performance.mark('sz:loadBoardData:end')
    performance.mark('sz:dataReady')
    window.api.app.bootMark?.('dataReady (loadBoardData done)')
    window.api.app.dataReady()
    // Fire exactly once, on the first non-pending state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardQ.isPending])

  // Bridge the global to REFETCH (not invalidate the board): callers `await
  // __slayzone_refreshData()` and need it to resolve AFTER fresh board data
  // lands. ALSO invalidate every other tRPC query so the cross-domain "refresh
  // everything" contract holds — external writes (CLI, IPC, e2e seeds, other
  // windows) that don't go through a tRPC mutation become visible app-wide.
  useEffect(() => {
    ;(window as any).__slayzone_refreshData = () => {
      void queryClient.invalidateQueries()
      return Promise.all([
        queryClient.refetchQueries(trpc.task.loadBoardData.queryFilter()),
        loadGroups()
      ])
    }
    return () => {
      delete (window as any).__slayzone_refreshData
    }
  }, [queryClient, trpc, loadGroups])

  // External changes: when a `tasks-changed` signal fires (CLI → REST → notify
  // bus), invalidate the board query and reload groups. Replaces the legacy
  // `app.onTasksChanged` IPC listener.
  useSubscription(
    trpc.notify.onTasksChanged.subscriptionOptions(undefined, {
      onData: () => {
        void queryClient.invalidateQueries(trpc.task.loadBoardData.queryFilter())
        void loadGroups()
      }
    })
  )

  // Tag CustomEvents patch local tags state directly (instant cross-component
  // sync without a board refetch). Blocked-changed re-pulls the blocked id set.
  useEffect(() => {
    const handleTagCreated = (e: Event) => {
      const tag = (e as CustomEvent).detail as Tag
      setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]))
    }
    const handleTagUpdated = (e: Event) => {
      const tag = (e as CustomEvent).detail as Tag
      setTags((prev) => prev.map((t) => (t.id === tag.id ? tag : t)))
    }
    const handleBlockedChanged = () => {
      void trpcClient.task.getAllBlockedTaskIds
        .query()
        .then((ids) => setBlockedTaskIds(new Set(ids)))
    }
    window.addEventListener('slayzone:tag-created', handleTagCreated)
    window.addEventListener('slayzone:tag-updated', handleTagUpdated)
    window.addEventListener('slayzone:blocked-changed', handleBlockedChanged)
    return () => {
      window.removeEventListener('slayzone:tag-created', handleTagCreated)
      window.removeEventListener('slayzone:tag-updated', handleTagUpdated)
      window.removeEventListener('slayzone:blocked-changed', handleBlockedChanged)
    }
  }, [trpcClient])

  // Update (or insert) a single task in state — upsert handles the race window
  // where a subtask exists in DB but loadBoardData hasn't refreshed yet
  const updateTask = useCallback((task: Task | null | undefined) => {
    if (!hasTaskIdentity(task)) return
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id)
      if (idx >= 0) return prev.map((t) => (t.id === task.id ? task : t))
      return [...prev, task]
    })
  }, [])

  // Move task between columns (status/priority)
  const moveTask = useCallback(
    (taskId: string, newColumnId: string, targetIndex: number, groupBy: GroupKey) => {
      if (groupBy === 'due_date') return

      const fieldUpdate =
        groupBy === 'status'
          ? { status: newColumnId as TaskStatus }
          : { priority: parseInt(newColumnId.slice(1), 10) }

      let snapshot: Task[] = []
      let newColumnTaskIds: string[] = []

      setTasks((prevTasks) => {
        snapshot = prevTasks

        const targetColumnTasks = prevTasks.filter((t) => {
          if (t.id === taskId) return false
          if (groupBy === 'status') return t.status === newColumnId
          return t.priority === parseInt(newColumnId.slice(1), 10)
        })

        newColumnTaskIds = [...targetColumnTasks.map((t) => t.id)]
        newColumnTaskIds.splice(targetIndex, 0, taskId)

        return prevTasks.map((t) => {
          if (t.id === taskId) {
            return { ...t, ...fieldUpdate, order: targetIndex }
          }
          const newOrder = newColumnTaskIds.indexOf(t.id)
          if (newOrder >= 0) {
            return { ...t, order: newOrder }
          }
          return t
        })
      })

      const updatePayload =
        groupBy === 'status'
          ? { id: taskId, status: newColumnId as TaskStatus }
          : { id: taskId, priority: parseInt(newColumnId.slice(1), 10) }

      Promise.all([
        trpcClient.task.update.mutate(updatePayload),
        trpcClient.task.reorder.mutate({ taskIds: newColumnTaskIds })
      ]).catch(() => {
        setTasks(snapshot)
      })
    },
    [trpcClient]
  )

  // Move multiple tasks to another column at targetIndex (cross-column).
  // Inserts ids consecutively at targetIndex preserving their input order.
  const bulkMove = useCallback(
    (taskIds: string[], newColumnId: string, targetIndex: number, groupBy: GroupKey) => {
      if (groupBy === 'due_date' || taskIds.length === 0) return

      const idSet = new Set(taskIds)
      const fieldUpdate =
        groupBy === 'status'
          ? { status: newColumnId as TaskStatus }
          : { priority: parseInt(newColumnId.slice(1), 10) }

      let snapshot: Task[] = []
      let newColumnTaskIds: string[] = []

      setTasks((prevTasks) => {
        snapshot = prevTasks

        const targetColumnTasks = prevTasks.filter((t) => {
          if (idSet.has(t.id)) return false
          if (groupBy === 'status') return t.status === newColumnId
          return t.priority === parseInt(newColumnId.slice(1), 10)
        })

        newColumnTaskIds = [...targetColumnTasks.map((t) => t.id)]
        newColumnTaskIds.splice(targetIndex, 0, ...taskIds)

        return prevTasks.map((t) => {
          if (idSet.has(t.id)) {
            const newOrder = newColumnTaskIds.indexOf(t.id)
            return { ...t, ...fieldUpdate, order: newOrder }
          }
          const newOrder = newColumnTaskIds.indexOf(t.id)
          if (newOrder >= 0) return { ...t, order: newOrder }
          return t
        })
      })

      const updatePayload =
        groupBy === 'status'
          ? { status: newColumnId as TaskStatus }
          : { priority: parseInt(newColumnId.slice(1), 10) }

      Promise.all([
        trpcClient.task.updateMany.mutate({ ids: taskIds, updates: updatePayload }),
        trpcClient.task.reorder.mutate({ taskIds: newColumnTaskIds })
      ]).catch(() => {
        setTasks(snapshot)
      })
    },
    [trpcClient]
  )

  // Reorder tasks within column
  const reorderTasks = useCallback(
    (taskIds: string[]) => {
      let snapshot: Task[] = []

      setTasks((prevTasks) => {
        snapshot = prevTasks
        return prevTasks.map((t) => {
          const newOrder = taskIds.indexOf(t.id)
          if (newOrder >= 0) {
            return { ...t, order: newOrder }
          }
          return t
        })
      })

      trpcClient.task.reorder.mutate({ taskIds }).catch(() => {
        setTasks(snapshot)
      })
    },
    [trpcClient]
  )

  // Reparent task + reorder its new sibling list. Used by tree drag-into-task.
  const reparentTask = useCallback(
    (taskId: string, newParentId: string | null, newSiblingTaskIds: string[]) => {
      let snapshot: Task[] = []
      setTasks((prevTasks) => {
        snapshot = prevTasks
        return prevTasks.map((t) => {
          if (t.id === taskId) {
            const newOrder = newSiblingTaskIds.indexOf(taskId)
            return { ...t, parent_id: newParentId, order: newOrder >= 0 ? newOrder : t.order }
          }
          const idx = newSiblingTaskIds.indexOf(t.id)
          if (idx >= 0) return { ...t, order: idx }
          return t
        })
      })
      Promise.all([
        trpcClient.task.update.mutate({ id: taskId, parentId: newParentId }),
        trpcClient.task.reorder.mutate({ taskIds: newSiblingTaskIds })
      ]).catch(() => setTasks(snapshot))
    },
    [trpcClient]
  )

  // Bulk variant — used when dragging a multi-selection in the tree view.
  // All `taskIds` get the same `newParentId`; `newSiblingTaskIds` is the new
  // ordered sibling list under that parent (which contains the moved ids in
  // their target positions plus any pre-existing siblings).
  const bulkReparent = useCallback(
    (taskIds: string[], newParentId: string | null, newSiblingTaskIds: string[]) => {
      if (taskIds.length === 0) return
      const idSet = new Set(taskIds)
      let snapshot: Task[] = []
      setTasks((prevTasks) => {
        snapshot = prevTasks
        return prevTasks.map((t) => {
          if (idSet.has(t.id)) {
            const newOrder = newSiblingTaskIds.indexOf(t.id)
            return { ...t, parent_id: newParentId, order: newOrder >= 0 ? newOrder : t.order }
          }
          const idx = newSiblingTaskIds.indexOf(t.id)
          if (idx >= 0) return { ...t, order: idx }
          return t
        })
      })
      Promise.all([
        trpcClient.task.updateMany.mutate({ ids: taskIds, updates: { parentId: newParentId } }),
        trpcClient.task.reorder.mutate({ taskIds: newSiblingTaskIds })
      ]).catch(() => setTasks(snapshot))
    },
    [trpcClient]
  )

  // Archive single task
  const archiveTask = useCallback(
    async (taskId: string) => {
      const now = new Date().toISOString()
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, archived_at: now } : t)))
      await trpcClient.task.archive.mutate({ id: taskId })
    },
    [trpcClient]
  )

  // Archive multiple tasks
  const archiveTasks = useCallback(
    async (taskIds: string[]) => {
      const now = new Date().toISOString()
      setTasks((prev) => prev.map((t) => (taskIds.includes(t.id) ? { ...t, archived_at: now } : t)))
      await trpcClient.task.archiveMany.mutate({ ids: taskIds })
    },
    [trpcClient]
  )

  // Delete task
  const deleteTask = useCallback(
    async (taskId: string) => {
      setTasks((prev) => prev.filter((t) => t.id !== taskId))
      await trpcClient.task.delete.mutate({ id: taskId })
    },
    [trpcClient]
  )

  // Bulk delete
  const bulkDelete = useCallback(
    async (taskIds: string[]) => {
      if (taskIds.length === 0) return
      const idSet = new Set(taskIds)
      let snapshot: Task[] = []
      setTasks((prev) => {
        snapshot = prev
        return prev.filter((t) => !idSet.has(t.id))
      })
      try {
        await trpcClient.task.deleteMany.mutate({ ids: taskIds })
      } catch {
        setTasks(snapshot)
      }
    },
    [trpcClient]
  )

  // Context menu update (status, priority, project, blocked).
  // Snapshot pattern keeps deps empty so the callback ref stays stable across
  // renders — prevents fanout re-renders in consumers (e.g. useUndoableTaskActions).
  const contextMenuUpdate = useCallback(
    async (taskId: string, updates: Partial<Task>) => {
      let previousTasks: Task[] = []
      setTasks((prev) => {
        previousTasks = prev
        return prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
      })

      if (updates.is_blocked !== undefined) {
        setBlockedTaskIds((prev) => {
          const next = new Set(prev)
          if (updates.is_blocked) next.add(taskId)
          else next.delete(taskId)
          return next
        })
      }

      try {
        await trpcClient.task.update.mutate({
          id: taskId,
          ...toUpdateTaskFields(updates)
        })
      } catch {
        setTasks(previousTasks)
        if (updates.is_blocked !== undefined) {
          setBlockedTaskIds((prev) => {
            const next = new Set(prev)
            if (updates.is_blocked) next.delete(taskId)
            else next.add(taskId)
            return next
          })
        }
      }
    },
    [trpcClient]
  )

  // Bulk context-menu update (status, priority, project, blocked, ...)
  const bulkContextMenuUpdate = useCallback(
    async (taskIds: string[], updates: Partial<Task>) => {
      if (taskIds.length === 0) return
      const idSet = new Set(taskIds)
      let previousTasks: Task[] = []
      setTasks((prev) => {
        previousTasks = prev
        return prev.map((t) => (idSet.has(t.id) ? { ...t, ...updates } : t))
      })

      if (updates.is_blocked !== undefined) {
        setBlockedTaskIds((prev) => {
          const next = new Set(prev)
          if (updates.is_blocked) for (const id of taskIds) next.add(id)
          else for (const id of taskIds) next.delete(id)
          return next
        })
      }

      try {
        await trpcClient.task.updateMany.mutate({
          ids: taskIds,
          updates: toUpdateTaskFields(updates)
        })
      } catch {
        setTasks(previousTasks)
        if (updates.is_blocked !== undefined) {
          setBlockedTaskIds((prev) => {
            const next = new Set(prev)
            if (updates.is_blocked) for (const id of taskIds) next.delete(id)
            else for (const id of taskIds) next.add(id)
            return next
          })
        }
      }
    },
    [trpcClient]
  )

  // Reorder the pinned group — writes `pin_order = index` for the ordered ids
  // in one bulk IPC. Optimistic with rollback.
  const reorderPinnedTasks = useCallback(
    (taskIds: string[]) => {
      if (taskIds.length === 0) return
      const orderById = new Map(taskIds.map((id, i) => [id, i]))
      let snapshot: Task[] = []
      setTasks((prev) => {
        snapshot = prev
        return prev.map((t) =>
          orderById.has(t.id)
            ? { ...t, pinned: true, pin_order: orderById.get(t.id) as number }
            : t
        )
      })
      trpcClient.task.reorderPinned.mutate({ taskIds }).catch(() => setTasks(snapshot))
    },
    [trpcClient]
  )

  // Pin / unpin tasks in the sidebar tree. Pinning appends after the current
  // pinned list and renumbers it (one bulk IPC); unpinning clears `pinned` /
  // `pin_order` (one bulk IPC). `pinned` / `pin_order` are task-intrinsic cols.
  const setTasksPinned = useCallback(
    (taskIds: string[], pinned: boolean) => {
      if (taskIds.length === 0) return
      const idSet = new Set(taskIds)
      let snapshot: Task[] = []
      let orderedPinnedIds: string[] = []
      setTasks((prev) => {
        snapshot = prev
        if (pinned) {
          const existing = prev
            .filter((t) => t.pinned && !idSet.has(t.id))
            .sort((a, b) => a.pin_order - b.pin_order)
            .map((t) => t.id)
          orderedPinnedIds = [...existing, ...taskIds]
          const orderById = new Map(orderedPinnedIds.map((id, i) => [id, i]))
          return prev.map((t) =>
            orderById.has(t.id)
              ? { ...t, pinned: true, pin_order: orderById.get(t.id) as number }
              : t
          )
        }
        return prev.map((t) =>
          idSet.has(t.id) ? { ...t, pinned: false, pin_order: 0 } : t
        )
      })
      const write = pinned
        ? trpcClient.task.reorderPinned.mutate({ taskIds: orderedPinnedIds })
        : trpcClient.task.updateMany.mutate({
            ids: taskIds,
            updates: { pinned: false, pinOrder: 0 }
          })
      write.catch(() => setTasks(snapshot))
    },
    [trpcClient]
  )

  const setTaskPinned = useCallback(
    (taskId: string, pinned: boolean) => setTasksPinned([taskId], pinned),
    [setTasksPinned]
  )

  // Collapse / expand a task's sub-tasks in the sidebar tree.
  const setTaskCollapsed = useCallback(
    (taskId: string, collapsed: boolean) => {
      let snapshot: Task[] = []
      setTasks((prev) => {
        snapshot = prev
        return prev.map((t) => (t.id === taskId ? { ...t, tree_collapsed: collapsed } : t))
      })
      trpcClient.task.update
        .mutate({ id: taskId, treeCollapsed: collapsed })
        .catch(() => setTasks(snapshot))
    },
    [trpcClient]
  )

  // Clear all dependency blockers (used when dragging out of __blocked__ col)
  const clearBlockers = useCallback(
    async (taskId: string) => {
      await trpcClient.task.setBlockers.mutate({ taskId, blockerTaskIds: [] })
      setBlockedTaskIds((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
      window.dispatchEvent(new CustomEvent('slayzone:blocked-changed'))
    },
    [trpcClient]
  )

  // Reorder projects
  const reorderProjects = useCallback(
    (projectIds: string[]) => {
      let snapshot: Project[] = []

      setProjects((prev) => {
        snapshot = prev
        const byId = new Map(prev.map((p) => [p.id, p]))
        const reordered = projectIds
          .map((id, index) => {
            const p = byId.get(id)
            return p ? { ...p, sort_order: index } : null
          })
          .filter((p): p is Project => p !== null)
        const seen = new Set(projectIds)
        const rest = prev.filter((p) => !seen.has(p.id))
        return [...reordered, ...rest]
      })

      trpcClient.projects.reorder.mutate({ projectIds }).catch(() => {
        setProjects(snapshot)
      })
    },
    [trpcClient]
  )

  // Update project in state
  const updateProject = useCallback((project: Project) => {
    setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)))
  }, [])

  // Delete project and its tasks
  const deleteProject = useCallback(
    (projectId: string, selectedProjectId: string, setSelectedProjectId: (id: string) => void) => {
      setProjects((prev) => {
        const remaining = prev.filter((p) => p.id !== projectId)
        if (selectedProjectId === projectId) {
          setSelectedProjectId(remaining.length > 0 ? remaining[0].id : '')
        }
        return remaining
      })
      setTasks((prev) => prev.filter((t) => t.project_id !== projectId))
    },
    []
  )

  // ── Project groups ───────────────────────────────────────────────────────
  // On the `projectGroups` tRPC router (vanilla client — stable ref, fire-and-
  // forget, safe in hook deps).
  //
  // Ordering mutations return an authoritative { projects, groups } snapshot
  // (the server re-packs both scopes to contiguous 0..n-1). We snapshot current
  // state for rollback, then replace with the server's truth on success. No
  // client-side optimism here — the dnd-kit drop animation covers the local IPC
  // round-trip, and replacing wholesale avoids client/server order divergence.
  const runGroupMutation = useCallback(
    (fn: () => Promise<{ projects: Project[]; groups: ProjectGroup[] }>) => {
      let projSnap: Project[] = []
      let groupSnap: ProjectGroup[] = []
      setProjects((p) => {
        projSnap = p
        return p
      })
      setProjectGroups((g) => {
        groupSnap = g
        return g
      })
      fn()
        .then((snap) => {
          setProjects(snap.projects)
          setProjectGroups(snap.groups)
        })
        .catch(() => {
          setProjects(projSnap)
          setProjectGroups(groupSnap)
        })
    },
    []
  )

  const createProjectGroup = useCallback(
    (name?: string) => runGroupMutation(() => trpcClient.projectGroups.create.mutate({ name })),
    [trpcClient]
  )
  const createFolderWithProjects = useCallback(
    (projectIds: string[]) => {
      if (projectIds.length === 0) return
      runGroupMutation(() =>
        trpcClient.projectGroups.createFolderWithProjects.mutate({ projectIds })
      )
    },
    [trpcClient]
  )
  const deleteProjectGroup = useCallback(
    (id: string) => runGroupMutation(() => trpcClient.projectGroups.delete.mutate({ id })),
    [trpcClient]
  )
  const reorderTopLevel = useCallback(
    (entries: TopLevelEntryRef[]) =>
      runGroupMutation(() => trpcClient.projectGroups.reorderTopLevel.mutate({ entries })),
    [trpcClient]
  )
  const moveProjectToGroup = useCallback(
    (projectId: string, groupId: string | null, targetIndex: number) =>
      runGroupMutation(() =>
        trpcClient.projectGroups.moveProject.mutate({ projectId, groupId, targetIndex })
      ),
    [trpcClient]
  )
  const reorderProjectsInGroup = useCallback(
    (groupId: string, projectIds: string[]) =>
      runGroupMutation(() =>
        trpcClient.projectGroups.reorderProjectsInGroup.mutate({ groupId, projectIds })
      ),
    [trpcClient]
  )

  // Rename / collapse return a single group → optimistic patch (instant toggle).
  const renameProjectGroup = useCallback(
    (id: string, name: string) => {
      let snap: ProjectGroup[] = []
      setProjectGroups((prev) => {
        snap = prev
        return prev.map((g) => (g.id === id ? { ...g, name } : g))
      })
      trpcClient.projectGroups.update.mutate({ id, name }).catch(() => setProjectGroups(snap))
    },
    [trpcClient]
  )
  const setGroupCollapsed = useCallback(
    (id: string, collapsed: boolean) => {
      let snap: ProjectGroup[] = []
      setProjectGroups((prev) => {
        snap = prev
        return prev.map((g) => (g.id === id ? { ...g, collapsed: collapsed ? 1 : 0 } : g))
      })
      trpcClient.projectGroups.update.mutate({ id, collapsed }).catch(() => setProjectGroups(snap))
    },
    [trpcClient]
  )

  return {
    tasks,
    projects,
    projectGroups,
    tags,
    taskTags,
    blockedTaskIds,
    setTasks,
    setProjects,
    setProjectGroups,
    setTags,
    setTaskTags,
    updateTask,
    moveTask,
    bulkMove,
    reorderTasks,
    reparentTask,
    bulkReparent,
    archiveTask,
    archiveTasks,
    deleteTask,
    bulkDelete,
    contextMenuUpdate,
    bulkContextMenuUpdate,
    setTaskPinned,
    setTasksPinned,
    setTaskCollapsed,
    reorderPinnedTasks,
    clearBlockers,
    updateProject,
    reorderProjects,
    deleteProject,
    createProjectGroup,
    createFolderWithProjects,
    renameProjectGroup,
    deleteProjectGroup,
    setGroupCollapsed,
    reorderTopLevel,
    moveProjectToGroup,
    reorderProjectsInGroup
  }
}
