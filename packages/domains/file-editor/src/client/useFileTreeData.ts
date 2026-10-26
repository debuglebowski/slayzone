import { useState, useCallback, useEffect, useInsertionEffect, useRef, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import { useStableCallback, useVisibleInterval } from '@slayzone/ui'
import type { DirEntry, GitFileStatus } from '../shared'
import { STATUS_PRIORITY, compactChildren } from './EditorFileTree.utils'
import { useWorkspaceTarget } from './workspace-target'

export interface VisibleEntry {
  entry: DirEntry
  depth: number
  displayName: string
  chainPaths: string[]
}

interface UseFileTreeDataArgs {
  projectPath: string
  refreshKey?: number
  controlledExpanded?: Set<string>
  onExpandedFoldersChange?: (folders: Set<string>) => void
  onReady?: () => void
}

export function useFileTreeData({
  projectPath,
  refreshKey,
  controlledExpanded,
  onExpandedFoldersChange,
  onReady
}: UseFileTreeDataArgs) {
  const trpc = useTRPC()
  // Which machine these filesystem calls are for. Ambient for the whole
  // panel — see ./workspace-target. Spread into every input so it also
  // keys the query cache.
  const target = useWorkspaceTarget()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  // Map of dirPath -> children entries (lazy loaded)
  const [dirContents, setDirContents] = useState<Map<string, DirEntry[]>>(new Map())
  const dirContentsRef = useRef(dirContents)
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set())
  const expandedFolders = controlledExpanded ?? internalExpanded
  const expandedFoldersRef = useRef(expandedFolders)
  const controlledRef = useRef(controlledExpanded)
  const onReadyRef = useRef(onReady)
  // Latest-value refs for handlers/timers; synced at commit, not during render.
  useInsertionEffect(() => {
    dirContentsRef.current = dirContents
    expandedFoldersRef.current = expandedFolders
    controlledRef.current = controlledExpanded
    onReadyRef.current = onReady
  })
  const setExpandedFolders = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      const update = (prev: Set<string>) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        onExpandedFoldersChange?.(next)
        return next
      }
      if (controlledRef.current) {
        update(controlledRef.current)
      } else {
        setInternalExpanded(update)
      }
    },
    [onExpandedFoldersChange]
  )

  // --- Git status ---
  const [gitStatus, setGitStatus] = useState<Map<string, GitFileStatus>>(new Map())

  const gitStatusQuery = useQuery(
    trpc.fileEditor.gitStatus.queryOptions({ ...target, rootPath: projectPath })
  )
  // refetch is identity-stable (bound once per observer), so the effect below
  // still re-runs only when refreshKey changes.
  const { refetch: refetchGitStatus } = gitStatusQuery

  // External retrigger: refetch when refreshKey changes identity. react-query
  // dedups against the in-flight mount fetch, so the initial run is a no-op.
  useEffect(() => {
    void refetchGitStatus()
  }, [refreshKey, refetchGitStatus])

  // Sync query result into the gitStatus Map, gated on isGitRepo (preserves the
  // old effect's "only set when a repo" + swallow-error semantics). Adjusted
  // during render whenever the result changes; starts as "no result yet" so a
  // result already cached at mount syncs too.
  const [gitStatusSyncedFrom, setGitStatusSyncedFrom] =
    useState<typeof gitStatusQuery.data>(undefined)
  if (gitStatusQuery.data !== gitStatusSyncedFrom) {
    const result = gitStatusQuery.data
    setGitStatusSyncedFrom(result)
    if (result && result.isGitRepo) setGitStatus(new Map(Object.entries(result.files)))
  }

  const dirGitStatus = useMemo(() => {
    const dirs = new Map<string, GitFileStatus>()
    for (const [filePath, status] of gitStatus) {
      const parts = filePath.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join('/')
        const current = dirs.get(dirPath)
        if (!current || STATUS_PRIORITY[status] > STATUS_PRIORITY[current]) {
          dirs.set(dirPath, status)
        }
      }
    }
    return dirs
  }, [gitStatus])

  // --- Flat visible entries for keyboard nav + shift-click ---
  const visibleEntries = useMemo(() => {
    const result: VisibleEntry[] = []
    function walk(parentPath: string, depth: number) {
      for (const c of compactChildren(parentPath, dirContents)) {
        result.push({
          entry: c.entry,
          depth,
          displayName: c.displayName,
          chainPaths: c.chainPaths
        })
        if (c.entry.type === 'directory' && expandedFolders.has(c.entry.path)) {
          walk(c.entry.path, depth + 1)
        }
      }
    }
    walk('', 0)
    return result
  }, [dirContents, expandedFolders])

  const loadDir = useCallback(
    async (dirPath: string) => {
      const input = { ...target, rootPath: projectPath, dirPath }
      const items = await trpcClient.fileEditor.readDir.query(input)
      queryClient.setQueryData(trpc.fileEditor.readDir.queryKey(input), items)
      setDirContents((prev) => {
        const next = new Map(prev)
        next.set(dirPath, items)
        return next
      })
      return items
    },
    [projectPath, queryClient, trpc, trpcClient, target]
  )
  const loadDirRef = useRef(loadDir)
  useInsertionEffect(() => {
    loadDirRef.current = loadDir
  })
  const watchRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onWatchEvent = useStableCallback(
    (event: { type: 'changed' | 'deleted'; root: string; relPath: string }) => {
      const normalize = (p: string) => p.replace(/\/+$/, '')
      if (normalize(event.root) !== normalize(projectPath)) return

      const slash = event.relPath.lastIndexOf('/')
      const parentDir = slash >= 0 ? event.relPath.slice(0, slash) : ''
      const dirsToRefresh = new Set<string>([''])
      if (parentDir && dirContentsRef.current.has(parentDir)) {
        dirsToRefresh.add(parentDir)
      }
      for (const dir of expandedFoldersRef.current) dirsToRefresh.add(dir)

      if (watchRefreshTimer.current) clearTimeout(watchRefreshTimer.current)
      watchRefreshTimer.current = setTimeout(() => {
        void queryClient.invalidateQueries(trpc.fileEditor.readDir.queryFilter())
        for (const dir of dirsToRefresh) void loadDirRef.current(dir)
      }, 100)
    }
  )

  useSubscription(
    trpc.fileEditor.watch.subscriptionOptions(
      { ...target, rootPath: projectPath },
      { onData: onWatchEvent }
    )
  )

  useEffect(() => {
    return () => {
      if (watchRefreshTimer.current) clearTimeout(watchRefreshTimer.current)
    }
  }, [])

  // fs.watch can miss early create/delete events on some platforms while the
  // WebSocket subscription is settling. Keep a cheap polling fallback for the
  // visible directories only; watcher events still provide fast refreshes.
  useVisibleInterval(() => {
    void loadDirRef.current('')
    for (const dir of expandedFoldersRef.current) void loadDirRef.current(dir)
  }, 1_500)

  // Load root + persisted expanded folders on mount (and whenever loadDir's
  // identity changes). Stable-callback body: reads the current expandedFolders
  // without making it a trigger.
  const loadInitialDirs = useStableCallback(() => {
    loadDir('').then(() => onReadyRef.current?.())
    expandedFolders.forEach((dir) => loadDir(dir))
  })
  useEffect(() => {
    loadInitialDirs()
  }, [loadDir, loadInitialDirs])

  // Reload expanded dirs on external file changes + clear collapsed folder caches.
  // Stable-callback body: triggered by refreshKey only, reads everything else fresh.
  const reloadOnRefreshKey = useStableCallback(() => {
    if (!refreshKey) return
    void queryClient.invalidateQueries(trpc.fileEditor.readDir.queryFilter())
    void queryClient.invalidateQueries(
      trpc.fileEditor.gitStatus.queryFilter({ ...target, rootPath: projectPath })
    )
    loadDir('')
    expandedFolders.forEach((dir) => loadDir(dir))
    setDirContents((prev) => {
      const keep = new Set(['', ...expandedFolders])
      let changed = false
      for (const key of prev.keys()) {
        if (!keep.has(key)) {
          changed = true
          break
        }
      }
      if (!changed) return prev
      const next = new Map<string, DirEntry[]>()
      for (const key of keep) {
        const val = prev.get(key)
        if (val) next.set(key, val)
      }
      return next
    })
  })
  useEffect(() => {
    reloadOnRefreshKey()
  }, [refreshKey, reloadOnRefreshKey])

  return {
    dirContents,
    expandedFolders,
    setExpandedFolders,
    loadDir,
    gitStatus,
    dirGitStatus,
    visibleEntries
  }
}
