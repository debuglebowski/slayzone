import { useMemo } from 'react'
import { typedTrpc } from '@slayzone/transport/client'
import {
  useWorkspaceTarget,
  type WorkspaceTarget
} from '@slayzone/file-editor/client/workspace-target'
// Type-only: erased from the client bundle. The routers' runtime stays server-side.
import type { AppShellMounts } from '@slayzone/host-capabilities/server'
import type { SettingsMounts } from '@slayzone/settings-core/server'
import type { TaskMounts } from '@slayzone/task/server'
import type { WorktreesAmbientMounts } from '../server/worktrees-router'

/**
 * This domain's typed view of the shared tRPC client (one runtime, one socket per hub),
 * typed against only the routers worktrees calls: its own `worktrees`, `task`,
 * `settings` and `app.shell`.
 */
const base = typedTrpc<WorktreesAmbientMounts & TaskMounts & SettingsMounts & AppShellMounts>()

/**
 * The git panel's PATH SCOPE (§9 Phase 7b): every `worktrees.*` call names the task
 * or project whose checkout it touches — the hub authorizes that, the computer
 * confines the call's paths to its folders. Ambient, like the file editor's target
 * ({@link WorkspaceTargetProvider}): the scope is a property of the whole panel, so
 * it is added to every `worktrees.*` input made through these hooks rather than
 * threaded through some sixty call sites, any one of which could forget it. A call
 * that names its own `target` keeps it. Only these hooks see `target` as optional
 * (`WorktreesAmbientMounts`); every other client sees it required. Outside any
 * provider nothing is added and the hub refuses the call (a query/mutation error).
 */
export function gitScopeOf(target: WorkspaceTarget): GitScopeTarget | null {
  if (target.taskId) return { taskId: target.taskId, computerId: target.computerId }
  if (target.projectId) return { projectId: target.projectId, computerId: target.computerId }
  return null
}
export type GitScopeTarget = { taskId?: string; projectId?: string; computerId?: string | null }

/**
 * `input` with the panel's scope, unless it names one (or is not an object input).
 * Never throws: this runs while rendering (`queryOptions`), so a call outside any
 * scope provider goes out as it is and the hub refuses it — a query/mutation
 * error, never an uncaught render exception.
 */
function withScope(input: unknown, scope: GitScopeTarget | null): unknown {
  if (!scope || input === null || typeof input !== 'object' || Array.isArray(input)) return input
  if ('target' in (input as Record<string, unknown>)) return input
  return { ...(input as Record<string, unknown>), target: scope }
}

type Fn = (...args: unknown[]) => unknown

/** One `worktrees.<proc>` of the options proxy, its inputs scoped. */
function scopeOptionsProcedure(proc: Record<string, Fn>, scope: GitScopeTarget | null) {
  return new Proxy(proc, {
    get(target, key: string) {
      const fn = target[key]
      if (typeof fn !== 'function') return fn
      if (key === 'mutationOptions') {
        return (...args: unknown[]) => {
          const opts = fn(...args) as { mutationFn?: Fn }
          const run = opts.mutationFn
          if (!run) return opts
          return {
            ...opts,
            mutationFn: (v: unknown, ...rest: unknown[]) => run(withScope(v, scope), ...rest)
          }
        }
      }
      if (
        key === 'queryOptions' ||
        key === 'queryKey' ||
        key === 'queryFilter' ||
        key === 'infiniteQueryOptions' ||
        key === 'subscriptionOptions'
      ) {
        return (input: unknown, ...rest: unknown[]) => fn(withScope(input, scope), ...rest)
      }
      return fn
    }
  })
}

/** One `worktrees.<proc>` of the vanilla client, its inputs scoped. */
function scopeClientProcedure(proc: Record<string, Fn>, scope: GitScopeTarget | null) {
  return new Proxy(proc, {
    get(target, key: string) {
      const fn = target[key]
      if (typeof fn !== 'function') return fn
      if (key === 'query' || key === 'mutate' || key === 'subscribe') {
        return (input: unknown, ...rest: unknown[]) => fn(withScope(input, scope), ...rest)
      }
      return fn
    }
  })
}

/** The root proxy with its `worktrees` namespace scoped per procedure. */
function scopeRoot<T extends object>(
  root: T,
  scope: GitScopeTarget | null,
  wrap: (proc: Record<string, Fn>, scope: GitScopeTarget | null) => unknown
): T {
  return new Proxy(root, {
    get(target, key, receiver) {
      const ns = Reflect.get(target, key, receiver)
      if (key !== 'worktrees' || !ns) return ns
      return new Proxy(ns as object, {
        get(nsTarget, proc, nsReceiver) {
          const p = Reflect.get(nsTarget, proc, nsReceiver)
          return p && typeof proc === 'string' ? wrap(p as Record<string, Fn>, scope) : p
        }
      })
    }
  })
}

/** The options proxy, `worktrees.*` inputs scoped to the panel's task / project. */
export function useTRPC(): ReturnType<typeof base.useTRPC> {
  const trpc = base.useTRPC()
  const target = useWorkspaceTarget()
  const scope = useMemo(() => gitScopeOf(target), [target])
  return useMemo(() => scopeRoot(trpc, scope, scopeOptionsProcedure), [trpc, scope])
}

/** The vanilla client, `worktrees.*` inputs scoped to the panel's task / project. */
export function useTRPCClient(): ReturnType<typeof base.useTRPCClient> {
  const client = base.useTRPCClient()
  const target = useWorkspaceTarget()
  const scope = useMemo(() => gitScopeOf(target), [target])
  return useMemo(() => scopeRoot(client, scope, scopeClientProcedure), [client, scope])
}
