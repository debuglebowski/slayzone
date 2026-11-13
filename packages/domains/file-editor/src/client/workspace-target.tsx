import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'

/**
 * Which machine the editor's filesystem calls are for.
 *
 * Every `fileEditor.*` procedure is routed to the computer that owns the workspace,
 * because the panel used to read and write the HUB's disk — so a task whose
 * checkout lived on a computer saw the wrong tree, and a save landed on a machine
 * no agent was working in.
 *
 * Ambient rather than a prop threaded through eight hooks, deliberately: the
 * target is a property of the panel as a whole, identical for every call inside
 * it, and passing it individually to `useFileEditor`, `useFileTreeData`,
 * `useFileTreeCrud`, `useFileTreeClipboard`, `useFileTreeDragDrop`,
 * `useFileDropZone`, `useWatchedFile` and `SearchPanel` would be eight chances to
 * forget one — and a forgotten one silently falls back to the default computer,
 * which looks like it works right up until the workspace is elsewhere.
 *
 * It still reaches the query keys: each hook spreads it into its tRPC input, so
 * rebinding a task to another computer invalidates that panel's cached tree rather
 * than showing the previous machine's files.
 *
 * The empty default means "the connected default computer", which is the right
 * answer for callers with no task context (the standalone artifact viewer, tests).
 */
export interface WorkspaceTarget {
  computerId?: string | null
  taskId?: string
  projectId?: string
}

const WorkspaceTargetContext = createContext<WorkspaceTarget>({})

export function WorkspaceTargetProvider({
  target,
  children
}: {
  target: WorkspaceTarget | undefined
  children: ReactNode
}) {
  // Memoized on the fields, not the object: callers pass an inline literal, and a
  // fresh identity every render would re-key every query beneath this provider.
  const value = useMemo(
    () => ({
      computerId: target?.computerId,
      taskId: target?.taskId,
      projectId: target?.projectId
    }),
    [target?.computerId, target?.taskId, target?.projectId]
  )
  return <WorkspaceTargetContext value={value}>{children}</WorkspaceTargetContext>
}

export function useWorkspaceTarget(): WorkspaceTarget {
  return useContext(WorkspaceTargetContext)
}

/**
 * The PATH SCOPE every `fileEditor.*` call names (§9 Phase 7b): the panel's task,
 * else its project. The hub authorizes it; the computer confines the call's paths
 * to that scope's folders. Same shape the router requires, so a call built without
 * one fails typecheck.
 */
export type WorkspaceScope = { computerId?: string | null } & (
  | { taskId: string; projectId?: string }
  | { taskId?: undefined; projectId: string }
)

/** The scope a target names, or null when it names neither a task nor a project. */
export function scopeOfTarget(target: WorkspaceTarget): WorkspaceScope | null {
  if (target.taskId)
    return { computerId: target.computerId, taskId: target.taskId, projectId: target.projectId }
  if (target.projectId) return { computerId: target.computerId, projectId: target.projectId }
  return null
}

/**
 * This panel's scope, or null outside any task / project panel. Queries then wait
 * (`skipToken`); commands refuse with {@link WorkspaceScopeMissingError} — never a
 * call that names nobody.
 */
export function useWorkspaceScope(): WorkspaceScope | null {
  const target = useWorkspaceTarget()
  return useMemo(() => scopeOfTarget(target), [target])
}

/** A file command issued outside any task / project panel. */
export class WorkspaceScopeMissingError extends Error {
  constructor() {
    super('File editor used outside a task or project: no path scope to name')
    this.name = 'WorkspaceScopeMissingError'
  }
}

/** `scope`, or throw: for commands, which have no "wait" state. */
export function requireScope(scope: WorkspaceScope | null): WorkspaceScope {
  if (!scope) throw new WorkspaceScopeMissingError()
  return scope
}

/**
 * Is this panel's workspace on the user's own machine?
 *
 * Gates the desktop-only affordances — "Reveal in Finder" resolves against THIS
 * desktop, so on a remote computer it would either fail or, worse, reveal an
 * unrelated directory that happens to share the path. Pending the answer it
 * returns false: briefly hiding an action beats offering one that misfires.
 */
export function useWorkspaceIsLocal(): boolean {
  const trpc = useTRPC()
  const target = useWorkspaceTarget()
  const query = useQuery(trpc.workspace.listRoots.queryOptions(target))
  return query.data?.isLocal ?? false
}
