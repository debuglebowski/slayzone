import { useState, useEffect, useCallback } from 'react'
import type { Task, TaskStatus } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import type { GroupKey } from './kanban'

function hasTaskIdentity(task: Task | null | undefined): task is Task {
  return !!task && typeof task.id === 'string' && task.id.length > 0
}

interface UseTasksDataReturn {
  // Data
  tasks: Task[]
  projects: Project[]
  tags: Tag[]
  taskTags: Map<string, string[]>
  blockedTaskIds: Set<string>

  // Setters (for dialog callbacks)
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>
  setTags: React.Dispatch<React.SetStateAction<Tag[]>>
  setTaskTags: React.Dispatch<React.SetStateAction<Map<string, string[]>>>

  // Task handlers
  updateTask: (task: Task | null | undefined) => void
  moveTask: (taskId: string, newColumnId: string, targetIndex: number, groupBy: GroupKey) => void
  bulkMove: (taskIds: string[], newColumnId: string, targetIndex: number, groupBy: GroupKey) => void
  reorderTasks: (taskIds: string[]) => void
  archiveTask: (taskId: string) => Promise<void>
  archiveTasks: (taskIds: string[]) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  bulkDelete: (taskIds: string[]) => Promise<void>
  contextMenuUpdate: (taskId: string, updates: Partial<Task>) => Promise<void>
  bulkContextMenuUpdate: (taskIds: string[], updates: Partial<Task>) => Promise<void>
  clearBlockers: (taskId: string) => Promise<void>

  // Project handlers
  updateProject: (project: Project) => void
  reorderProjects: (projectIds: string[]) => void
  deleteProject: (projectId: string, selectedProjectId: string, setSelectedProjectId: (id: string) => void) => void
}

export function useTasksData(): UseTasksDataReturn {
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [taskTags, setTaskTags] = useState<Map<string, string[]>>(new Map())
  const [blockedTaskIds, setBlockedTaskIds] = useState<Set<string>>(new Set())

  // Load data on mount + allow external refresh (E2E tests)
  useEffect(() => {
    let inFlight = false
    let pending = false
    let firstLoad = true

    const loadData = () => {
      if (inFlight) { pending = true; return }
      inFlight = true
      pending = false
      if (firstLoad) {
        performance.mark('sz:loadBoardData:start')
        window.api.app.bootMark?.('loadBoardData start')
      }
      getTrpcVanillaClient().task.loadBoardData.query().then((data) => {
        setTasks(data.tasks as Task[])
        setProjects(data.projects as Project[])
        setTags(data.tags as Tag[])
        setTaskTags(new Map(Object.entries(data.taskTags)))
        setBlockedTaskIds(new Set(data.blockedTaskIds))
      }).finally(() => {
        if (firstLoad) {
          performance.mark('sz:loadBoardData:end')
          firstLoad = false
          performance.mark('sz:dataReady')
          window.api.app.bootMark?.('dataReady (loadBoardData done)')
          window.api.app.dataReady()
        }
        inFlight = false
        if (pending) loadData()
      })
    }
    loadData()
    ;(window as any).__slayzone_refreshData = loadData
    const _sub = getTrpcVanillaClient().task.onChanged.subscribe(undefined, { onData: () => loadData() }); const cleanup = () => _sub.unsubscribe()
    const handleTagCreated = (e: Event) => {
      const tag = (e as CustomEvent).detail as Tag
      setTags((prev) => prev.some((t) => t.id === tag.id) ? prev : [...prev, tag])
    }
    const handleTagUpdated = (e: Event) => {
      const tag = (e as CustomEvent).detail as Tag
      setTags((prev) => prev.map((t) => t.id === tag.id ? tag : t))
    }
    const handleBlockedChanged = () => {
      getTrpcVanillaClient().task.getAllBlockedTaskIds.query().then(ids => setBlockedTaskIds(new Set(ids)))
    }
    window.addEventListener('slayzone:tag-created', handleTagCreated)
    window.addEventListener('slayzone:tag-updated', handleTagUpdated)
    window.addEventListener('slayzone:blocked-changed', handleBlockedChanged)
    return () => {
      delete (window as any).__slayzone_refreshData
      cleanup?.()
      window.removeEventListener('slayzone:tag-created', handleTagCreated)
      window.removeEventListener('slayzone:tag-updated', handleTagUpdated)
      window.removeEventListener('slayzone:blocked-changed', handleBlockedChanged)
    }
  }, [])

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
  const moveTask = useCallback((
    taskId: string,
    newColumnId: string,
    targetIndex: number,
    groupBy: GroupKey
  ) => {
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
      getTrpcVanillaClient().task.update.mutate(updatePayload),
      getTrpcVanillaClient().task.reorder.mutate({ taskIds: newColumnTaskIds })
    ]).catch(() => {
      setTasks(snapshot)
    })
  }, [])

  // Move multiple tasks to another column at targetIndex (cross-column).
  // Inserts ids consecutively at targetIndex preserving their input order.
  const bulkMove = useCallback((
    taskIds: string[],
    newColumnId: string,
    targetIndex: number,
    groupBy: GroupKey
  ) => {
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
      getTrpcVanillaClient().task.updateMany.mutate({ ids: taskIds, updates: updatePayload }),
      getTrpcVanillaClient().task.reorder.mutate({ taskIds: newColumnTaskIds })
    ]).catch(() => {
      setTasks(snapshot)
    })
  }, [])

  // Reorder tasks within column
  const reorderTasks = useCallback((taskIds: string[]) => {
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

    getTrpcVanillaClient().task.reorder.mutate({ taskIds: taskIds }).catch(() => {
      setTasks(snapshot)
    })
  }, [])

  // Archive single task
  const archiveTask = useCallback(async (taskId: string) => {
    const now = new Date().toISOString()
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, archived_at: now } : t))
    await getTrpcVanillaClient().task.archive.mutate({ id: taskId })
  }, [])

  // Archive multiple tasks
  const archiveTasks = useCallback(async (taskIds: string[]) => {
    const now = new Date().toISOString()
    setTasks((prev) => prev.map((t) => taskIds.includes(t.id) ? { ...t, archived_at: now } : t))
    await getTrpcVanillaClient().task.archiveMany.mutate({ ids: taskIds })
  }, [])

  // Delete task
  const deleteTask = useCallback(async (taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
    await getTrpcVanillaClient().task.delete.mutate({ id: taskId })
  }, [])

  // Bulk delete
  const bulkDelete = useCallback(async (taskIds: string[]) => {
    if (taskIds.length === 0) return
    const idSet = new Set(taskIds)
    let snapshot: Task[] = []
    setTasks((prev) => {
      snapshot = prev
      return prev.filter((t) => !idSet.has(t.id))
    })
    try {
      await getTrpcVanillaClient().task.deleteMany.mutate({ ids: taskIds })
    } catch {
      setTasks(snapshot)
    }
  }, [])

  // Context menu update (status, priority, project, blocked).
  // Snapshot pattern keeps deps empty so the callback ref stays stable across
  // renders — prevents fanout re-renders in consumers (e.g. useUndoableTaskActions).
  const contextMenuUpdate = useCallback(async (taskId: string, updates: Partial<Task>) => {
    let previousTasks: Task[] = []
    setTasks((prev) => {
      previousTasks = prev
      return prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
    })

    if (updates.is_blocked !== undefined) {
      setBlockedTaskIds(prev => {
        const next = new Set(prev)
        if (updates.is_blocked) next.add(taskId)
        else next.delete(taskId)
        return next
      })
    }

    try {
      await getTrpcVanillaClient().task.update.mutate({
        id: taskId,
        status: updates.status,
        priority: updates.priority,
        progress: updates.progress,
        projectId: updates.project_id,
        snoozedUntil: updates.snoozed_until,
        isBlocked: updates.is_blocked,
        blockedComment: updates.blocked_comment
      })
    } catch {
      setTasks(previousTasks)
      if (updates.is_blocked !== undefined) {
        setBlockedTaskIds(prev => {
          const next = new Set(prev)
          if (updates.is_blocked) next.delete(taskId)
          else next.add(taskId)
          return next
        })
      }
    }
  }, [])

  // Bulk context-menu update (status, priority, project, blocked, ...)
  const bulkContextMenuUpdate = useCallback(async (taskIds: string[], updates: Partial<Task>) => {
    if (taskIds.length === 0) return
    const idSet = new Set(taskIds)
    let previousTasks: Task[] = []
    setTasks((prev) => {
      previousTasks = prev
      return prev.map((t) => (idSet.has(t.id) ? { ...t, ...updates } : t))
    })

    if (updates.is_blocked !== undefined) {
      setBlockedTaskIds(prev => {
        const next = new Set(prev)
        if (updates.is_blocked) for (const id of taskIds) next.add(id)
        else for (const id of taskIds) next.delete(id)
        return next
      })
    }

    try {
      await getTrpcVanillaClient().task.updateMany.mutate({
        ids: taskIds,
        updates: {
          status: updates.status,
          priority: updates.priority,
          progress: updates.progress,
          projectId: updates.project_id,
          snoozedUntil: updates.snoozed_until,
          isBlocked: updates.is_blocked,
          blockedComment: updates.blocked_comment
        }
      })
    } catch {
      setTasks(previousTasks)
      if (updates.is_blocked !== undefined) {
        setBlockedTaskIds(prev => {
          const next = new Set(prev)
          if (updates.is_blocked) for (const id of taskIds) next.delete(id)
          else for (const id of taskIds) next.add(id)
          return next
        })
      }
    }
  }, [])

  // Clear all dependency blockers (used when dragging out of __blocked__ col)
  const clearBlockers = useCallback(async (taskId: string) => {
    await getTrpcVanillaClient().task.setBlockers.mutate({ taskId: taskId, blockerTaskIds: [] })
    setBlockedTaskIds(prev => {
      const next = new Set(prev)
      next.delete(taskId)
      return next
    })
    window.dispatchEvent(new CustomEvent('slayzone:blocked-changed'))
  }, [])

  // Reorder projects
  const reorderProjects = useCallback((projectIds: string[]) => {
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

    getTrpcVanillaClient().projects.reorder.mutate({ projectIds }).catch(() => {
      setProjects(snapshot)
    })
  }, [])

  // Update project in state
  const updateProject = useCallback((project: Project) => {
    setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)))
  }, [])

  // Delete project and its tasks
  const deleteProject = useCallback((
    projectId: string,
    selectedProjectId: string,
    setSelectedProjectId: (id: string) => void
  ) => {
    setProjects((prev) => {
      const remaining = prev.filter((p) => p.id !== projectId)
      if (selectedProjectId === projectId) {
        setSelectedProjectId(remaining.length > 0 ? remaining[0].id : '')
      }
      return remaining
    })
    setTasks((prev) => prev.filter((t) => t.project_id !== projectId))
  }, [])

  return {
    tasks,
    projects,
    tags,
    taskTags,
    blockedTaskIds,
    setTasks,
    setProjects,
    setTags,
    setTaskTags,
    updateTask,
    moveTask,
    bulkMove,
    reorderTasks,
    archiveTask,
    archiveTasks,
    deleteTask,
    bulkDelete,
    contextMenuUpdate,
    bulkContextMenuUpdate,
    clearBlockers,
    updateProject,
    reorderProjects,
    deleteProject
  }
}
