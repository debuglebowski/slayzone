import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { toast } from '@slayzone/ui'
import { useTRPC } from '../trpc'

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
 * Keeps everything sharing decides fresh: an `onChanged` naming the caller (it gained
 * or lost something) refetches the sharing queries, the projects and the board.
 * Mount once per hub connection (the app shell).
 */
export function useSharingLiveUpdates(): void {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { enabled } = useSharingStatus()
  useSubscription(
    trpc.sharing.onChanged.subscriptionOptions(undefined, {
      enabled,
      onData: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.sharing.pathKey() })
        void queryClient.invalidateQueries(trpc.projects.list.queryFilter())
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
