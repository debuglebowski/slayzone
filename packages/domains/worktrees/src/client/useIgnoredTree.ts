import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { useTRPCClient } from './trpc'
import {
  IgnoredTreeLoader,
  type IgnoredTreeSnapshot,
  type IgnoredTreeSource
} from './ignored-tree-loader'
import { createLoaderLifetime } from './loader-lifetime'

const CLOSED: IgnoredTreeSnapshot = { status: 'loading', totalFiles: 0, dirs: new Map() }
const EMPTY = { loader: null, value: CLOSED }
const closedSnapshot = () => EMPTY
const subscribeNone = () => () => undefined

/** One active index per open/scoped checkout; Activity cleanup cancels its captured client. */
export function useIgnoredTree(
  repoPath: string,
  open: boolean
): { loader: IgnoredTreeLoader | null; snapshot: IgnoredTreeSnapshot } {
  const client = useTRPCClient()
  const lifetime = useMemo(() => {
    if (!open) return null
    return createLoaderLifetime(
      CLOSED,
      (signal) => {
        const source: IgnoredTreeSource = {
          open: () => client.worktrees.openIgnoredTree.query({ repoPath }, { signal }),
          list: (treeId, dir, cursor) =>
            client.worktrees.listIgnoredTree.query({ repoPath, treeId, dir, cursor }, { signal }),
          match: (treeId, globs, cursor) =>
            client.worktrees.matchIgnoredTree.query({ repoPath, treeId, globs, cursor }, { signal })
        }
        return new IgnoredTreeLoader(source)
      },
      (loader) => {
        void loader.start()
      }
    )
  }, [client, repoPath, open])
  useLayoutEffect(() => {
    lifetime?.activate()
    return () => lifetime?.deactivate()
  }, [lifetime])
  const view = useSyncExternalStore(
    lifetime?.subscribe ?? subscribeNone,
    lifetime?.getSnapshot ?? closedSnapshot
  )
  return { loader: view.loader, snapshot: view.value }
}
