import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import { useVisibleInterval } from '@slayzone/ui'
import type { DirEntry, GitFileStatus } from '../shared'
import { STATUS_PRIORITY, compactChildren } from './EditorFileTree.utils'

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
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  // Map of dirPath -> children entries (lazy loaded)
  const [dirContents, setDirContents] = useState<Map<string, DirEntry[]>>(new Map())
  const dirContentsRef = useRef(dirContents)
  dirContentsRef.current = dirContents
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set())
  const expandedFolders = controlledExpanded ?? internalExpanded
  const expandedFoldersRef = useRef(expandedFolders)
  expandedFoldersRef.current = expandedFolders
  const controlledRef = useRef(controlledExpanded)
  controlledRef.current = controlledExpanded
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
    trpc.fileEditor.gitStatus.queryOptions({ rootPath: projectPath })
  )

  // External retrigger: refetch when refreshKey changes identity. react-query
  // dedups against the in-flight mount fetch, so the initial run is a no-op.
  useEffect(() => {
    void gitStatusQuery.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // Sync query result into the gitStatus Map, gated on isGitRepo (preserves the
  // old effect's "only set when a repo" + swallow-error semantics).
  useEffect(() => {
    const result = gitStatusQuery.data
    if (!result || !result.isGitRepo) return
    setGitStatus(new Map(Object.entries(result.files)))
  }, [gitStatusQuery.data])

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
      const input = { rootPath: projectPath, dirPath }
      const items = await trpcClient.fileEditor.readDir.query(input)
      queryClient.setQueryData(trpc.fileEditor.readDir.queryKey(input), items)
      setDirContents((prev) => {
        const next = new Map(prev)
        next.set(dirPath, items)
        return next
      })
      return items
    },
    [projectPath, queryClient, trpc, trpcClient]
  )
  const loadDirRef = useRef(loadDir)
  loadDirRef.current = loadDir
  const watchRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useSubscription(
    trpc.fileEditor.watch.subscriptionOptions(
      { rootPath: projectPath },
      {
        onData: (event) => {
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
      }
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

  // Load root + persisted expanded folders on mount
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  useEffect(() => {
    loadDir('').then(() => onReadyRef.current?.())
    expandedFolders.forEach((dir) => loadDir(dir))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDir])

  // Reload expanded dirs on external file changes + clear collapsed folder caches
  useEffect(() => {
    if (!refreshKey) return
    void queryClient.invalidateQueries(
      trpc.fileEditor.readDir.queryFilter()
    )
    void queryClient.invalidateQueries(
      trpc.fileEditor.gitStatus.queryFilter({ rootPath: projectPath })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

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
