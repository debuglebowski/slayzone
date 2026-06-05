import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
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
  // Map of dirPath -> children entries (lazy loaded)
  const [dirContents, setDirContents] = useState<Map<string, DirEntry[]>>(new Map())
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set())
  const expandedFolders = controlledExpanded ?? internalExpanded
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

  useEffect(() => {
    let cancelled = false
    window.api.fs
      .gitStatus(projectPath)
      .then((result) => {
        if (cancelled || !result.isGitRepo) return
        setGitStatus(new Map(Object.entries(result.files)))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectPath, refreshKey])

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
      const items = await window.api.fs.readDir(projectPath, dirPath)
      setDirContents((prev) => {
        const next = new Map(prev)
        next.set(dirPath, items)
        return next
      })
      return items
    },
    [projectPath]
  )

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
