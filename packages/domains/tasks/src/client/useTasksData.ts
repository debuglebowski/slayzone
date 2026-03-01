import { useState, useEffect, useCallback } from 'react'
import type { Task, TaskStatus } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
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

  // Task handlers
  updateTask: (task: Task | null | undefined) => void
  moveTask: (taskId: string, newColumnId: string, targetIndex: number, groupBy: GroupKey) => void
  reorderTasks: (taskIds: string[]) => void
  archiveTask: (taskId: string) => Promise<void>
  archiveTasks: (taskIds: string[]) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  contextMenuUpdate: (taskId: string, updates: Partial<Task>) => Promise<void>

  // Project handlers
  updateProject: (project: Project) => void
  deleteProject: (projectId: string, selectedProjectId: string | null, setSelectedProjectId: (id: string | null) => void) => void
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
      Promise.all([
        window.api.db.getTasks(),
        window.api.db.getProjects(),
        window.api.tags.getTags(),
        window.api.taskTags.getAll(),
        window.api.taskDependencies.getAllBlockedTaskIds()
      ]).then(([t, p, tg, allTagMap, allBlockedIds]) => {
        setTasks(t as Task[])
        setProjects(p as Project[])
        setTags(tg as Tag[])
        setTaskTags(new Map(Object.entries(allTagMap as Record<string, string[]>)))
        setBlockedTaskIds(new Set(allBlockedIds as string[]))
      }).finally(() => {
        if (firstLoad) {
          firstLoad = false
          window.api.app.dataReady()
        }
        inFlight = false
        if (pending) loadData()
      })
    }
    loadData()
    ;(window as any).__slayzone_refreshData = loadData
    const cleanup = window.api?.app?.onTasksChanged?.(loadData)
    return () => {
      delete (window as any).__slayzone_refreshData
      cleanup?.()
    }
  }, [])

  // Update a single task in state
  const updateTask = useCallback((task: Task | null | undefined) => {
    if (!hasTaskIdentity(task)) return
    setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)))
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

    setTasks((prevTasks) => {
      const targetColumnTasks = prevTasks.filter((t) => {
        if (t.id === taskId) return false
        if (groupBy === 'status') return t.status === newColumnId
        return t.priority === parseInt(newColumnId.slice(1), 10)
      })

      const newColumnTaskIds = [...targetColumnTasks.map((t) => t.id)]
      newColumnTaskIds.splice(targetIndex, 0, taskId)

      const previousTasks = prevTasks
      const updatedTasks = prevTasks.map((t) => {
        if (t.id === taskId) {
          return { ...t, ...fieldUpdate, order: targetIndex }
        }
        const newOrder = newColumnTaskIds.indexOf(t.id)
        if (newOrder >= 0) {
          return { ...t, order: newOrder }
        }
        return t
      })

      // Async DB call
      const updatePayload =
        groupBy === 'status'
          ? { id: taskId, status: newColumnId as TaskStatus }
          : { id: taskId, priority: parseInt(newColumnId.slice(1), 10) }

      Promise.all([
        window.api.db.updateTask(updatePayload),
        window.api.db.reorderTasks(newColumnTaskIds)
      ]).catch(() => {
        setTasks(previousTasks)
      })

      return updatedTasks
    })
  }, [])

  // Reorder tasks within column
  const reorderTasks = useCallback((taskIds: string[]) => {
    setTasks((prevTasks) => {
      const previousTasks = prevTasks
      const updatedTasks = prevTasks.map((t) => {
        const newOrder = taskIds.indexOf(t.id)
        if (newOrder >= 0) {
          return { ...t, order: newOrder }
        }
        return t
      })

      window.api.db.reorderTasks(taskIds).catch(() => {
        setTasks(previousTasks)
      })

      return updatedTasks
    })
  }, [])

  // Archive single task
  const archiveTask = useCallback(async (taskId: string) => {
    const now = new Date().toISOString()
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, archived_at: now } : t))
    await window.api.db.archiveTask(taskId)
  }, [])

  // Archive multiple tasks
  const archiveTasks = useCallback(async (taskIds: string[]) => {
    const now = new Date().toISOString()
    setTasks((prev) => prev.map((t) => taskIds.includes(t.id) ? { ...t, archived_at: now } : t))
    await window.api.db.archiveTasks(taskIds)
  }, [])

  // Delete task
  const deleteTask = useCallback(async (taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
    await window.api.db.deleteTask(taskId)
  }, [])

  // Context menu update (status, priority, project)
  const contextMenuUpdate = useCallback(async (taskId: string, updates: Partial<Task>) => {
    let previousTasks: Task[]
    setTasks((prev) => {
      previousTasks = prev
      return prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
    })

    try {
      await window.api.db.updateTask({
        id: taskId,
        status: updates.status,
        priority: updates.priority,
        projectId: updates.project_id
      })
    } catch {
      setTasks(previousTasks!)
    }
  }, [])

  // Update project in state
  const updateProject = useCallback((project: Project) => {
    setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)))
  }, [])

  // Delete project and its tasks
  const deleteProject = useCallback((
    projectId: string,
    selectedProjectId: string | null,
    setSelectedProjectId: (id: string | null) => void
  ) => {
    setProjects((prev) => {
      const remaining = prev.filter((p) => p.id !== projectId)
      if (selectedProjectId === projectId) {
        setSelectedProjectId(remaining.length > 0 ? remaining[0].id : null)
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
    updateTask,
    moveTask,
    reorderTasks,
    archiveTask,
    archiveTasks,
    deleteTask,
    contextMenuUpdate,
    updateProject,
    deleteProject
  }
}
