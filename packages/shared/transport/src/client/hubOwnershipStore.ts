import { useMemo } from 'react'
import { create } from 'zustand'
import { getHubClient, getTrpcClient, useTRPCClient, type TrpcVanillaClient } from './trpc'

/**
 * Which hub OWNS a project / task — the map every write has to consult before it
 * picks a client. A project lives in exactly one hub's SQLite DB, so a mutation
 * sent to any other hub either no-ops or (for an INSERT keyed on `project_id`)
 * fails the foreign key.
 *
 * It lives here, above the React tree, because the map used to be private refs
 * inside the board hook (`useTasksData`) — which meant every creation path
 * (create-task dialog, scratch terminal, subtask) had no way to reach it and
 * silently wrote to the default hub. The board recompose is still the
 * authoritative writer; it just publishes here instead of keeping it to itself.
 *
 * `noteProjectHub` / `noteTaskHub` cover the window a bulk write can't: a task
 * created on a remote hub is not in ANY board snapshot until that hub's own
 * reload lands, and a recompose in between would drop it — leaving the fresh
 * tab pointed at the default hub. Seeds are therefore kept in a side map and
 * re-merged on top of every `setOwnership`, retiring once the authoritative
 * board carries the id (at which point the board's value wins).
 */

type OwnershipMap = Map<string, string>

/** An entity id as callers actually hold it — often not selected yet. */
type MaybeId = string | null | undefined

type HubOwnershipState = {
  hubIdByProject: OwnershipMap
  hubIdByTask: OwnershipMap
  /** Ids noted by a create that no `setOwnership` has confirmed yet. */
  seededProjects: OwnershipMap
  seededTasks: OwnershipMap
  /** Authoritative bulk publish (the cross-hub board recompose). */
  setOwnership: (projects: OwnershipMap, tasks: OwnershipMap) => void
  noteProjectHub: (projectId: string, hubId: string) => void
  noteTaskHub: (taskId: string, hubId: string) => void
}

/** Bulk wins for ids it carries; unconfirmed seeds ride on top and stay pending. */
function mergeSeeds(
  bulk: OwnershipMap,
  seeds: OwnershipMap
): { merged: OwnershipMap; pending: OwnershipMap } {
  if (seeds.size === 0) return { merged: bulk, pending: seeds }
  const merged = new Map(bulk)
  const pending: OwnershipMap = new Map()
  for (const [id, hubId] of seeds) {
    if (bulk.has(id)) continue
    pending.set(id, hubId)
    merged.set(id, hubId)
  }
  return { merged, pending }
}

export const useHubOwnershipStore = create<HubOwnershipState>((set) => ({
  hubIdByProject: new Map(),
  hubIdByTask: new Map(),
  seededProjects: new Map(),
  seededTasks: new Map(),
  setOwnership: (projects, tasks) =>
    set((s) => {
      const p = mergeSeeds(projects, s.seededProjects)
      const t = mergeSeeds(tasks, s.seededTasks)
      return {
        hubIdByProject: p.merged,
        hubIdByTask: t.merged,
        seededProjects: p.pending,
        seededTasks: t.pending
      }
    }),
  noteProjectHub: (projectId, hubId) =>
    set((s) => ({
      hubIdByProject: new Map(s.hubIdByProject).set(projectId, hubId),
      seededProjects: new Map(s.seededProjects).set(projectId, hubId)
    })),
  noteTaskHub: (taskId, hubId) =>
    set((s) => ({
      hubIdByTask: new Map(s.hubIdByTask).set(taskId, hubId),
      seededTasks: new Map(s.seededTasks).set(taskId, hubId)
    }))
}))

export function getHubIdForProject(projectId: MaybeId): string | undefined {
  return projectId ? useHubOwnershipStore.getState().hubIdByProject.get(projectId) : undefined
}

export function getHubIdForTask(taskId: MaybeId): string | undefined {
  return taskId ? useHubOwnershipStore.getState().hubIdByTask.get(taskId) : undefined
}

/**
 * The vanilla client for a hub id, falling back to `fallback` (default: the boot
 * singleton, i.e. the default hub) when the hub is unknown or has no client yet.
 * An ownership entry for a hub implies its client exists — the entry can only
 * come from a board fetch that already resolved that hub — so the fallback is
 * reached for the default hub and for unowned ids, which is exactly where the
 * default client is the right answer.
 */
export function getClientForHub(
  hubId: MaybeId,
  fallback?: TrpcVanillaClient
): TrpcVanillaClient {
  const resolved = hubId ? getHubClient(hubId)?.client : null
  return resolved ?? fallback ?? getTrpcClient()
}

export function getClientForProject(projectId: MaybeId): TrpcVanillaClient {
  return getClientForHub(getHubIdForProject(projectId))
}

export function getClientForTask(taskId: MaybeId): TrpcVanillaClient {
  return getClientForHub(getHubIdForTask(taskId))
}

/** Reactive `hubIdByProject.get(projectId)` — re-renders when ownership changes. */
export function useHubIdForProject(projectId: MaybeId): string | undefined {
  return useHubOwnershipStore((s) => (projectId ? s.hubIdByProject.get(projectId) : undefined))
}

/** Reactive `hubIdByTask.get(taskId)`. */
export function useHubIdForTask(taskId: MaybeId): string | undefined {
  return useHubOwnershipStore((s) => (taskId ? s.hubIdByTask.get(taskId) : undefined))
}

/**
 * The client that owns `projectId`. Falls back to the AMBIENT client (the
 * enclosing `HubScope`), not the boot singleton — inside a task tab's scope the
 * ambient client is already the right hub, so an id we don't know yet must not
 * be yanked back to the default hub.
 */
export function useClientForProject(projectId: MaybeId): TrpcVanillaClient {
  const ambient = useTRPCClient()
  const hubId = useHubIdForProject(projectId)
  return useMemo(() => getClientForHub(hubId, ambient), [hubId, ambient])
}

/** The client that owns `taskId`. Same ambient fallback as `useClientForProject`. */
export function useClientForTask(taskId: MaybeId): TrpcVanillaClient {
  const ambient = useTRPCClient()
  const hubId = useHubIdForTask(taskId)
  return useMemo(() => getClientForHub(hubId, ambient), [hubId, ambient])
}
