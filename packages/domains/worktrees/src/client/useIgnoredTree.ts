import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTRPCClient } from './trpc'
import {
  IgnoredTreeLoader,
  type IgnoredTreeSnapshot,
  type IgnoredTreeSource
} from './ignored-tree-loader'

const CLOSED: IgnoredTreeSnapshot = { status: 'loading', totalFiles: 0, dirs: new Map() }
const unsubscribeNone = (): void => {
  /* nothing subscribed */
}
const subscribeNone = (): (() => void) => unsubscribeNone
const closedSnapshot = (): IgnoredTreeSnapshot => CLOSED

/**
 * The copy dialog's lazy ignored-file tree for `repoPath`: a fresh index each time
 * the dialog opens (as the whole-tree query refetched on every open), its
 * directories loaded on demand. Calls go through the panel's scoped vanilla client
 * — pages are held by the loader, never cached a second time.
 */
export function useIgnoredTree(
  repoPath: string,
  open: boolean
): { loader: IgnoredTreeLoader | null; snapshot: IgnoredTreeSnapshot } {
  const client = useTRPCClient()
  const [held, setHeld] = useState<{
    open: boolean
    repoPath: string
    loader: IgnoredTreeLoader | null
  } | null>(null)
  if (held === null || held.open !== open || held.repoPath !== repoPath) {
    const source: IgnoredTreeSource = {
      open: () => client.worktrees.openIgnoredTree.query({ repoPath }),
      list: (treeId, dir, cursor) =>
        client.worktrees.listIgnoredTree.query({ repoPath, treeId, dir, cursor }),
      match: (treeId, globs, cursor) =>
        client.worktrees.matchIgnoredTree.query({ repoPath, treeId, globs, cursor })
    }
    setHeld({ open, repoPath, loader: open ? new IgnoredTreeLoader(source) : null })
  }
  const loader = held?.loader ?? null

  useEffect(() => {
    if (!loader) return
    void loader.start()
    return () => loader.dispose()
  }, [loader])

  const snapshot = useSyncExternalStore(
    loader?.subscribe ?? subscribeNone,
    loader?.getSnapshot ?? closedSnapshot
  )
  return { loader, snapshot }
}
