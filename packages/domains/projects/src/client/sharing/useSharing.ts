import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { toast } from '@slayzone/ui'
import { useTRPC, useTRPCClient } from '../trpc'

export type AccessRole = 'view' | 'edit' | 'manage'

export const ROLE_LABEL: Record<AccessRole, string> = {
  view: 'Can view',
  edit: 'Can edit',
  manage: 'Can manage'
}

export const ROLE_HINT: Record<AccessRole, string> = {
  view: 'Read only',
  edit: 'Change it, and run agents on their own computer',
  manage: 'Also decide who else gets in'
}

/**
 * Whether sharing applies on the current hub: only a hub with login has users to
 * share with (T-100). False while unknown, so nothing flashes on a desktop hub.
 */
export function useSharingStatus(): { enabled: boolean; userId: string | null } {
  const trpc = useTRPC()
  const q = useQuery({ ...trpc.sharing.status.queryOptions(), staleTime: Infinity, retry: false })
  return { enabled: q.data?.enabled === true, userId: q.data?.userId ?? null }
}

/** The hub's enabled accounts, by id — for names and the people picker. */
export function useDirectory(enabled: boolean) {
  const trpc = useTRPC()
  const q = useQuery({ ...trpc.sharing.directory.queryOptions(), enabled, staleTime: 60_000 })
  const users = q.data ?? []
  const byId = new Map(users.map((u) => [u.id, u]))
  const nameOf = (id: string | null | undefined): string => {
    if (!id) return 'Unknown'
    const u = byId.get(id)
    return u ? u.name || u.email : 'Former user'
  }
  return { users, byId, nameOf }
}

/** The caller's own role on one resource; null while loading or without access. */
export function useMyRole(
  kind: 'project' | 'task' | 'artifact' | 'taskOwner',
  id: string | null | undefined
) {
  const trpc = useTRPC()
  const { enabled } = useSharingStatus()
  const q = useQuery({
    ...trpc.sharing.myRoles.queryOptions({ resources: id ? [{ kind, id }] : [] }),
    enabled: enabled && !!id
  })
  // Without login the one operator manages everything.
  if (!enabled) return 'manage' as AccessRole
  return (id ? (q.data?.[`${kind}:${id}`] ?? null) : null) as AccessRole | null
}

/**
 * Whether the caller may change a resource (T-100): false only once its role is known
 * to be View. True without login and while the role loads, so nothing flashes read-only
 * for its owner; the hub refuses a View member's write either way.
 */
export function useCanEdit(kind: 'project' | 'task' | 'artifact', id: string | null | undefined) {
  const trpc = useTRPC()
  const { enabled } = useSharingStatus()
  const q = useQuery({
    ...trpc.sharing.myRoles.queryOptions({ resources: id ? [{ kind, id }] : [] }),
    enabled: enabled && !!id
  })
  if (!enabled || !id || !q.data) return true
  return q.data[`${kind}:${id}`] !== 'view'
}

/**
 * Keeps everything sharing decides fresh: an `onChanged` naming the caller (it gained
 * or lost something) refetches the sharing queries and the projects, then calls
 * `onAccessChanged` (the board hook reloads the board). Mounted by `useTasksData`.
 */
export function useSharingLiveUpdates(onAccessChanged: () => void): void {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { enabled } = useSharingStatus()
  useSubscription(
    trpc.sharing.onChanged.subscriptionOptions(undefined, {
      enabled,
      onData: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.sharing.pathKey() })
        void queryClient.invalidateQueries(trpc.projects.list.queryFilter())
        onAccessChanged()
      }
    })
  )
}

/** A mutation failure as a toast (FORBIDDEN carries its own plain message). */
export function toastError(err: unknown): void {
  toast.error(err instanceof Error ? err.message : String(err))
}

/**
 * Whether the task's agents and terminals are the caller's (T-100): they run on the
 * task owner's computers only — a member sees the task, never another person's
 * terminal. True without login, and while unknown (nothing flashes for an owner).
 */
export function useRunsAgentsHere(taskId: string | null | undefined): boolean {
  const trpc = useTRPC()
  const { enabled } = useSharingStatus()
  const q = useQuery({
    ...trpc.sharing.myRoles.queryOptions({
      resources: taskId ? [{ kind: 'taskOwner', id: taskId }] : []
    }),
    enabled: enabled && !!taskId
  })
  if (!enabled || !taskId || !q.data) return true
  return q.data[`taskOwner:${taskId}`] != null
}

/**
 * The caller's roles on every task of the board, in ONE request (T-100): each card and
 * menu reads its own from this cache ({@link useIsTaskViewOnly}) instead of asking
 * per task. Under `sharing`, so an access change refetches it with the rest.
 */
const BOARD_ROLES_KEY = [['sharing', 'boardRoles']] as const

/** Keep the board's role cache for `taskIds`. Mounted by the board hook. */
export function useBoardRoles(taskIds: readonly string[]): void {
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const { enabled } = useSharingStatus()
  const idsRef = useRef(taskIds)
  const signature = taskIds.join(',')
  useEffect(() => {
    idsRef.current = taskIds
  })
  useQuery({
    queryKey: BOARD_ROLES_KEY,
    queryFn: () =>
      idsRef.current.length === 0
        ? Promise.resolve({} as Record<string, string | null>)
        : client.sharing.myRoles.query({
            resources: idsRef.current.map((id) => ({ kind: 'task' as const, id }))
          }),
    enabled
  })
  // A different set of tasks: ask again (the key stays one, so every card's reader
  // keeps reading the same cache).
  useEffect(() => {
    if (enabled) void queryClient.invalidateQueries({ queryKey: BOARD_ROLES_KEY })
  }, [enabled, signature, queryClient])
}

/**
 * Whether the board's role cache says the caller may only view this task. Reads the
 * cache only (never fetches, never re-renders unless this task's answer changes).
 */
export function useIsTaskViewOnly(taskId: string): boolean {
  const queryClient = useQueryClient()
  return useSyncExternalStore(
    (onChange) => queryClient.getQueryCache().subscribe(onChange),
    () =>
      queryClient.getQueryData<Record<string, string | null>>(BOARD_ROLES_KEY)?.[
        `task:${taskId}`
      ] === 'view'
  )
}
