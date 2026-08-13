import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'

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
