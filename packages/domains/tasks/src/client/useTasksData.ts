import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  electronBootstrap,
  useTRPC,
  useTRPCClient,
  useSubscription,
  useFederationOrNull,
  getHubClient,
  type TrpcVanillaClient
} from '@slayzone/transport/client'
import type { Task, TaskStatus } from '@slayzone/task/shared'
import type { Project, ProjectGroup, TopLevelEntryRef } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { GroupKey } from './kanban'

function hasTaskIdentity(task: Task | null | undefined): task is Task {
  return !!task && typeof task.id === 'string' && task.id.length > 0
}

/** Sentinel used when no FederationProvider is mounted (e.g. the Chromium fork
 *  renders useTasksData without federation). Matches the local hub id, so every
 *  row is attributed to "the one hub" and all routing falls through to the
 *  ambient client — byte-identical to the pre-federation single-client world. */
const LOCAL_FALLBACK_HUB_ID = 'local'

/** Structural shape of `task.loadBoardData` (client view — rows are the shared
 *  Task/Project/Tag types). Mirrors the server op's return without importing
 *  the electron-coupled server module into renderer code. */
type BoardData = {
  tasks: Task[]
  projects: Project[]
  tags: Tag[]
  taskTags: Record<string, string[]>
  blockedTaskIds: string[]
}

/** Partition an id list by owning hub (preserving order within each hub), for
 *  ops that can legitimately span hubs (e.g. the tree-global pinned list). Ids
 *  absent from the lookup fall to the default hub. */
function groupIdsByHub(
  ids: string[],
  lookup: Map<string, string>,
  defaultHubId: string
): Map<string, string[]> {
  const byHub = new Map<string, string[]>()
  for (const id of ids) {
    const hubId = lookup.get(id) ?? defaultHubId
    const bucket = byHub.get(hubId)
    if (bucket) bucket.push(id)
    else byHub.set(hubId, [id])
  }
  return byHub
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

  // Multi-hub federation: project id → owning hub id. App derives the selected
  // project's hub from this (selection stays a bare id). Empty when single-hub.
  hubIdByProject: Map<string, string>
  // task id → owning hub id — lets App scope each open task tab to its hub.
  hubIdByTask: Map<string, string>

  // Board-load lifecycle (the loadBoardData query) so consumers can tell
  // "connecting" / "failed to reach the server" apart from a genuinely empty
  // workspace — they read identical (all-empty) arrays otherwise.
  boardStatus: 'pending' | 'error' | 'success'
  boardError: { message: string } | null

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

  // ── Multi-hub federation ──────────────────────────────────────────────────
  // The rail shows a flat union of every connected hub's projects/tasks. This
  // hook is the seam: the DEFAULT hub keeps the exact declarative path below
  // (byte-identical when single-hub); EXTRA hubs are fetched imperatively via
  // their registry vanilla clients and MERGED into the same state arrays. Rows
  // stay bare shared types — origin is tracked in side maps so App's ~48
  // `id === selectedProjectId` comparisons and the DB contract are untouched.
  const fed = useFederationOrNull()
  const defaultHubId = fed?.defaultHubId ?? LOCAL_FALLBACK_HUB_ID
  const extraHubs = useMemo(
    () => (fed ? fed.hubs.filter((h) => h.id !== fed.defaultHubId && !!h.url) : []),
    [fed]
  )

  // Origin maps: id → owning hub id. Kept in refs (stable-ref mutation routing
  // reads `.current` without dep churn) AND mirrored to state (App re-derives
  // the selected project's hub reactively when a remote hub's data lands).
  const hubIdByProjectRef = useRef<Map<string, string>>(new Map())
  const hubIdByTaskRef = useRef<Map<string, string>>(new Map())
  const groupHubIdRef = useRef<Map<string, string>>(new Map())
  const [hubIdByProject, setHubIdByProject] = useState<Map<string, string>>(new Map())
  const [hubIdByTask, setHubIdByTask] = useState<Map<string, string>>(new Map())

  // Per-hub raw payloads, recomposed into the merged arrays. The default hub's
  // board flows through `boardQ`; extra hubs through these refs.
  const extraBoardsRef = useRef<Map<string, BoardData>>(new Map())
  const defaultGroupsRef = useRef<ProjectGroup[]>([])
  const extraGroupsRef = useRef<Map<string, ProjectGroup[]>>(new Map())

  // Board data spine: declarative query is the source of truth for the DEFAULT
  // hub; the useState mirrors below stay so the many optimistic mutation
  // handlers keep working unchanged and consumers keep reading synchronous arrays.
  const boardQ = useQuery(trpc.task.loadBoardData.queryOptions(undefined, { staleTime: 30_000 }))

  // Rebuild the merged task/project/tag arrays + origin maps from the default
  // board (boardQ) plus every extra hub's board. With no extra hubs this is
  // exactly `setX(boardQ.data.x)` — byte-identical to the pre-federation seed.
  const recomposeBoards = useCallback(() => {
    const projByHub = new Map<string, string>()
    const taskByHub = new Map<string, string>()
    const allTasks: Task[] = []
    const allProjects: Project[] = []
    const allTags: Tag[] = []
    const allTaskTags = new Map<string, string[]>()
    const allBlocked = new Set<string>()
    const absorb = (hubId: string, d: BoardData): void => {
      for (const p of d.projects as Project[]) {
        allProjects.push(p)
        projByHub.set(p.id, hubId)
      }
      for (const t of d.tasks as Task[]) {
        allTasks.push(t)
        taskByHub.set(t.id, hubId)
      }
      for (const tag of d.tags as Tag[]) allTags.push(tag)
      for (const [k, v] of Object.entries(d.taskTags)) allTaskTags.set(k, v)
      for (const id of d.blockedTaskIds) allBlocked.add(id)
    }
    if (boardQ.data) absorb(defaultHubId, boardQ.data as BoardData)
    for (const [hubId, d] of extraBoardsRef.current) absorb(hubId, d)
    hubIdByProjectRef.current = projByHub
    hubIdByTaskRef.current = taskByHub
    setTasks(allTasks)
    setProjects(allProjects)
    setTags(allTags)
    setTaskTags(allTaskTags)
    setBlockedTaskIds(allBlocked)
    setHubIdByProject(projByHub)
    setHubIdByTask(taskByHub)
  }, [boardQ.data, defaultHubId])

  // Rebuild the merged project-groups array + origin map (default + extra hubs).
  const recomposeGroups = useCallback(() => {
    const byHub = new Map<string, string>()
    const all: ProjectGroup[] = []
    const absorb = (hubId: string, groups: ProjectGroup[]): void => {
      for (const g of groups) {
        all.push(g)
        byHub.set(g.id, hubId)
      }
    }
    absorb(defaultHubId, defaultGroupsRef.current)
    for (const [hubId, groups] of extraGroupsRef.current) absorb(hubId, groups)
    groupHubIdRef.current = byHub
    setProjectGroups(all)
  }, [defaultHubId])

  // Boot timing: mark the board-load start once on mount (the query auto-fires
  // here). Paired with the end/dataReady marks below. `app.bootMark` has no
  // tRPC router, so it stays on the IPC bridge.
  useEffect(() => {
    performance.mark('sz:loadBoardData:start')
    electronBootstrap.bootMark('loadBoardData start')
  }, [])

  // Project groups loaded imperatively via the `projectGroups` tRPC router and
  // mirrored into `projectGroups` state (the many optimistic mutation handlers
  // below keep reading a synchronous array). The `__slayzone_refreshData` bridge
  // and the onTasksChanged subscription both re-run this loader alongside the
  // board query. Vanilla client (stable ref) — fire-and-forget, no hook deps churn.
  const loadGroups = useCallback(() => {
    return trpcClient.projectGroups.list.query().then((groups) => {
      defaultGroupsRef.current = groups as ProjectGroup[]
      recomposeGroups()
    })
  }, [trpcClient, recomposeGroups])

  // Seed the useState mirrors from the (default hub) board query result, merged
  // with any extra-hub boards already fetched.
  useEffect(() => {
    if (!boardQ.data) return
    recomposeBoards()
  }, [boardQ.data, recomposeBoards])

  // Initial groups load (mount-only; refresh paths re-run loadGroups directly).
  useEffect(() => {
    void loadGroups()
  }, [loadGroups])

  // ── Extra-hub board + group fetch (federation) ────────────────────────────
  // For each non-default hub, fetch its board + groups via its registry vanilla
  // client, stash into the extra refs, recompose, and subscribe to its
  // tasks-changed so external writes on that hub surface. No-op with a single
  // hub (extraHubs empty) → single-hub path is byte-identical.
  useEffect(() => {
    if (!fed || extraHubs.length === 0) return
    let cancelled = false
    const unsubs: Array<() => void> = []
    const liveHubIds = new Set(extraHubs.map((h) => h.id))
    // Drop stale hubs (removed from the registry) before refetch.
    for (const id of [...extraBoardsRef.current.keys()]) {
      if (!liveHubIds.has(id)) extraBoardsRef.current.delete(id)
    }
    for (const id of [...extraGroupsRef.current.keys()]) {
      if (!liveHubIds.has(id)) extraGroupsRef.current.delete(id)
    }
    const loadHub = (hubId: string, client: TrpcVanillaClient): void => {
      void client.task.loadBoardData
        .query()
        .then((d) => {
          if (cancelled) return
          extraBoardsRef.current.set(hubId, d as BoardData)
          recomposeBoards()
        })
        .catch(() => undefined)
      void client.projectGroups.list
        .query()
        .then((groups) => {
          if (cancelled) return
          extraGroupsRef.current.set(hubId, groups as ProjectGroup[])
          recomposeGroups()
        })
        .catch(() => undefined)
    }
    for (const hub of extraHubs) {
      const resolved = fed.resolve(hub.id)
      if (!resolved) continue
      const client = resolved.ws.client
      loadHub(hub.id, client)
      try {
        const sub = client.notify.onTasksChanged.subscribe(undefined, {
          onData: () => loadHub(hub.id, client)
        })
        unsubs.push(() => sub.unsubscribe())
      } catch {
        /* subscription unsupported — polled refresh via __slayzone_refreshData */
      }
    }
    return () => {
      cancelled = true
      for (const u of unsubs) u()
    }
  }, [fed, extraHubs, recomposeBoards, recomposeGroups])

  // Mutation routing: resolve the vanilla client that OWNS an entity so writes
  // land on the right hub. Falls back to the ambient default-hub client when the
  // id isn't federated (single-hub → always the default → byte-identical).
  const clientForHub = useCallback(
    (hubId: string | undefined): TrpcVanillaClient => {
      if (!hubId || hubId === defaultHubId) return trpcClient
      return getHubClient(hubId)?.client ?? trpcClient
    },
    [defaultHubId, trpcClient]
  )
  const clientForProject = useCallback(
    (projectId: string | undefined): TrpcVanillaClient =>
      clientForHub(projectId ? hubIdByProjectRef.current.get(projectId) : undefined),
    [clientForHub]
  )
  const clientForTask = useCallback(
    (taskId: string | undefined): TrpcVanillaClient =>
      clientForHub(taskId ? hubIdByTaskRef.current.get(taskId) : undefined),
    [clientForHub]
  )
  const clientForGroup = useCallback(
    (groupId: string | undefined): TrpcVanillaClient =>
      clientForHub(groupId ? groupHubIdRef.current.get(groupId) : undefined),
    [clientForHub]
  )
  // True when the given ids span more than one hub — such an op (cross-hub
  // reorder / folder) is structurally meaningless (groups + sort_order are
  // per-DB), so callers reject it.
  const spansHubs = useCallback((ids: string[], lookup: Map<string, string>): boolean => {
    let seen: string | undefined
    for (const id of ids) {
      const h = lookup.get(id) ?? defaultHubId
      if (seen === undefined) seen = h
      else if (seen !== h) return true
    }
    return false
  }, [defaultHubId])

  // Boot instrumentation: fire bootMark/dataReady once the board query first
  // lands, preserving the legacy single-shot signal. `app.bootMark`/`dataReady`
  // have no tRPC router, so they stay on the IPC bridge.
  useEffect(() => {
    if (boardQ.isPending) return
    performance.mark('sz:loadBoardData:end')
    performance.mark('sz:dataReady')
    electronBootstrap.bootMark('dataReady (loadBoardData done)')
    electronBootstrap.dataReady()
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

      const c = clientForTask(taskId)
      Promise.all([
        c.task.update.mutate(updatePayload),
        c.task.reorder.mutate({ taskIds: newColumnTaskIds })
      ]).catch(() => {
        setTasks(snapshot)
      })
    },
    [clientForTask]
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

      const c = clientForTask(taskIds[0])
      Promise.all([
        c.task.updateMany.mutate({ ids: taskIds, updates: updatePayload }),
        c.task.reorder.mutate({ taskIds: newColumnTaskIds })
      ]).catch(() => {
        setTasks(snapshot)
      })
    },
    [clientForTask]
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

      clientForTask(taskIds[0]).task.reorder.mutate({ taskIds }).catch(() => {
        setTasks(snapshot)
      })
    },
    [clientForTask]
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
      const c = clientForTask(taskId)
      Promise.all([
        c.task.update.mutate({ id: taskId, parentId: newParentId }),
        c.task.reorder.mutate({ taskIds: newSiblingTaskIds })
      ]).catch(() => setTasks(snapshot))
    },
    [clientForTask]
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
      const c = clientForTask(taskIds[0])
      Promise.all([
        c.task.updateMany.mutate({ ids: taskIds, updates: { parentId: newParentId } }),
        c.task.reorder.mutate({ taskIds: newSiblingTaskIds })
      ]).catch(() => setTasks(snapshot))
    },
    [clientForTask]
  )

  // Archive single task
  const archiveTask = useCallback(
    async (taskId: string) => {
      const now = new Date().toISOString()
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, archived_at: now } : t)))
      await clientForTask(taskId).task.archive.mutate({ id: taskId })
    },
    [clientForTask]
  )

  // Archive multiple tasks
  const archiveTasks = useCallback(
    async (taskIds: string[]) => {
      const now = new Date().toISOString()
      setTasks((prev) => prev.map((t) => (taskIds.includes(t.id) ? { ...t, archived_at: now } : t)))
      await clientForTask(taskIds[0]).task.archiveMany.mutate({ ids: taskIds })
    },
    [clientForTask]
  )

  // Delete task
  const deleteTask = useCallback(
    async (taskId: string) => {
      const c = clientForTask(taskId)
      setTasks((prev) => prev.filter((t) => t.id !== taskId))
      await c.task.delete.mutate({ id: taskId })
    },
    [clientForTask]
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
        await clientForTask(taskIds[0]).task.deleteMany.mutate({ ids: taskIds })
      } catch {
        setTasks(snapshot)
      }
    },
    [clientForTask]
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
        await clientForTask(taskId).task.update.mutate({
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
    [clientForTask]
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
        await clientForTask(taskIds[0]).task.updateMany.mutate({
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
    [clientForTask]
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
      // Pinned list is tree-global and may span hubs — reorder each hub's slice
      // on its own client (pin_order is per-DB, so a cross-hub order is only
      // meaningful within each hub anyway).
      const byHub = groupIdsByHub(taskIds, hubIdByTaskRef.current, defaultHubId)
      Promise.all(
        [...byHub].map(([hubId, ids]) => clientForHub(hubId).task.reorderPinned.mutate({ taskIds: ids }))
      ).catch(() => setTasks(snapshot))
    },
    [clientForHub, defaultHubId]
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
      // Pin/unpin can span hubs (tree-global) — split by owning hub and issue
      // one write per hub (pin_order is per-DB).
      const writes = pinned
        ? [...groupIdsByHub(orderedPinnedIds, hubIdByTaskRef.current, defaultHubId)].map(
            ([hubId, ids]) => clientForHub(hubId).task.reorderPinned.mutate({ taskIds: ids })
          )
        : [...groupIdsByHub(taskIds, hubIdByTaskRef.current, defaultHubId)].map(([hubId, ids]) =>
            clientForHub(hubId).task.updateMany.mutate({
              ids,
              updates: { pinned: false, pinOrder: 0 }
            })
          )
      Promise.all(writes).catch(() => setTasks(snapshot))
    },
    [clientForHub, defaultHubId]
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
      clientForTask(taskId)
        .task.update.mutate({ id: taskId, treeCollapsed: collapsed })
        .catch(() => setTasks(snapshot))
    },
    [clientForTask]
  )

  // Clear all dependency blockers (used when dragging out of __blocked__ col)
  const clearBlockers = useCallback(
    async (taskId: string) => {
      await clientForTask(taskId).task.setBlockers.mutate({ taskId, blockerTaskIds: [] })
      setBlockedTaskIds((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
      window.dispatchEvent(new CustomEvent('slayzone:blocked-changed'))
    },
    [clientForTask]
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

      // Cross-hub reorder is meaningless (sort_order is per-DB) — reject it.
      if (spansHubs(projectIds, hubIdByProjectRef.current)) {
        setProjects(snapshot)
        return
      }
      clientForProject(projectIds[0]).projects.reorder.mutate({ projectIds }).catch(() => {
        setProjects(snapshot)
      })
    },
    [clientForProject, spansHubs]
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
  // for ONE hub (the server re-packs both scopes to contiguous 0..n-1). Under
  // federation we splice only THAT hub's rows back into the merged arrays,
  // keeping other hubs' projects/groups intact. With a single hub this is a
  // wholesale replace — byte-identical to before.
  const runGroupMutation = useCallback(
    (hubId: string, fn: () => Promise<{ projects: Project[]; groups: ProjectGroup[] }>) => {
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
          // Cache this hub's authoritative slice, then recompose so the merged
          // arrays reflect the new order for this hub while preserving others.
          if (hubId === defaultHubId) {
            defaultGroupsRef.current = snap.groups
          } else {
            extraGroupsRef.current.set(hubId, snap.groups)
            const b = extraBoardsRef.current.get(hubId)
            if (b) extraBoardsRef.current.set(hubId, { ...b, projects: snap.projects })
          }
          // Projects: replace this hub's rows in-place (origin map unchanged —
          // same ids, new sort_order), then recompose groups.
          setProjects((prev) => {
            const others = prev.filter((p) => (hubIdByProjectRef.current.get(p.id) ?? defaultHubId) !== hubId)
            return hubId === defaultHubId ? [...snap.projects, ...others] : [...others, ...snap.projects]
          })
          recomposeGroups()
        })
        .catch(() => {
          setProjects(projSnap)
          setProjectGroups(groupSnap)
        })
    },
    [defaultHubId, recomposeGroups]
  )

  const createProjectGroup = useCallback(
    (name?: string) =>
      // A bare new group has no project → attribute it to the default hub.
      runGroupMutation(defaultHubId, () => trpcClient.projectGroups.create.mutate({ name })),
    [trpcClient, runGroupMutation, defaultHubId]
  )
  const createFolderWithProjects = useCallback(
    (projectIds: string[]) => {
      if (projectIds.length === 0) return
      if (spansHubs(projectIds, hubIdByProjectRef.current)) return // cross-hub folder rejected
      const hubId = hubIdByProjectRef.current.get(projectIds[0]) ?? defaultHubId
      runGroupMutation(hubId, () =>
        clientForProject(projectIds[0]).projectGroups.createFolderWithProjects.mutate({ projectIds })
      )
    },
    [clientForProject, runGroupMutation, spansHubs, defaultHubId]
  )
  const deleteProjectGroup = useCallback(
    (id: string) => {
      const hubId = groupHubIdRef.current.get(id) ?? defaultHubId
      runGroupMutation(hubId, () => clientForGroup(id).projectGroups.delete.mutate({ id }))
    },
    [clientForGroup, runGroupMutation, defaultHubId]
  )
  const reorderTopLevel = useCallback(
    (entries: TopLevelEntryRef[]) => {
      // Top-level entries mix projects + groups; resolve each to its hub and
      // reject a cross-hub reorder (top-level order is per-DB).
      const hubIds = entries.map(
        (e) =>
          (e.kind === 'group' ? groupHubIdRef.current.get(e.id) : hubIdByProjectRef.current.get(e.id)) ??
          defaultHubId
      )
      const hubId = hubIds[0] ?? defaultHubId
      if (hubIds.some((h) => h !== hubId)) return // cross-hub top-level reorder rejected
      runGroupMutation(hubId, () => clientForHub(hubId).projectGroups.reorderTopLevel.mutate({ entries }))
    },
    [clientForHub, runGroupMutation, defaultHubId]
  )
  const moveProjectToGroup = useCallback(
    (projectId: string, groupId: string | null, targetIndex: number) => {
      const projHub = hubIdByProjectRef.current.get(projectId) ?? defaultHubId
      // Moving a project into a group that lives on a different hub is invalid.
      if (groupId && (groupHubIdRef.current.get(groupId) ?? defaultHubId) !== projHub) return
      runGroupMutation(projHub, () =>
        clientForProject(projectId).projectGroups.moveProject.mutate({ projectId, groupId, targetIndex })
      )
    },
    [clientForProject, runGroupMutation, defaultHubId]
  )
  const reorderProjectsInGroup = useCallback(
    (groupId: string, projectIds: string[]) => {
      const hubId = groupHubIdRef.current.get(groupId) ?? defaultHubId
      runGroupMutation(hubId, () =>
        clientForGroup(groupId).projectGroups.reorderProjectsInGroup.mutate({ groupId, projectIds })
      )
    },
    [clientForGroup, runGroupMutation, defaultHubId]
  )

  // Rename / collapse return a single group → optimistic patch (instant toggle).
  const renameProjectGroup = useCallback(
    (id: string, name: string) => {
      let snap: ProjectGroup[] = []
      setProjectGroups((prev) => {
        snap = prev
        return prev.map((g) => (g.id === id ? { ...g, name } : g))
      })
      clientForGroup(id).projectGroups.update.mutate({ id, name }).catch(() => setProjectGroups(snap))
    },
    [clientForGroup]
  )
  const setGroupCollapsed = useCallback(
    (id: string, collapsed: boolean) => {
      let snap: ProjectGroup[] = []
      setProjectGroups((prev) => {
        snap = prev
        return prev.map((g) => (g.id === id ? { ...g, collapsed: collapsed ? 1 : 0 } : g))
      })
      clientForGroup(id)
        .projectGroups.update.mutate({ id, collapsed })
        .catch(() => setProjectGroups(snap))
    },
    [clientForGroup]
  )

  return {
    tasks,
    projects,
    projectGroups,
    tags,
    taskTags,
    blockedTaskIds,
    hubIdByProject,
    hubIdByTask,
    boardStatus: boardQ.status,
    boardError: boardQ.error,
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
