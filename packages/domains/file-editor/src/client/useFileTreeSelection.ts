import { useState, useCallback, useEffect, useRef } from 'react'
import type { DirEntry } from '../shared'
import type { VisibleEntry } from './useFileTreeData'

interface UseFileTreeSelectionArgs {
  visibleEntries: VisibleEntry[]
  onOpenFile: (path: string) => void
  handleToggleFolder: (folderPath: string, chainPaths?: string[]) => void
}

export function useFileTreeSelection({
  visibleEntries,
  onOpenFile,
  handleToggleFolder
}: UseFileTreeSelectionArgs) {
  // --- Multi-select state ---
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)

  // --- Focus state for keyboard navigation ---
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const treeContainerRef = useRef<HTMLDivElement>(null)

  // --- Auto-scroll focused entry into view ---
  useEffect(() => {
    if (!focusedPath) return
    const el = treeContainerRef.current?.querySelector(`[data-path="${CSS.escape(focusedPath)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusedPath])

  const getEffectiveSelection = useCallback(
    (entry: DirEntry): string[] => {
      if (selectedPaths.has(entry.path) && selectedPaths.size > 1) return [...selectedPaths]
      return [entry.path]
    },
    [selectedPaths]
  )

  // --- Click handler with modifier support ---
  const handleEntryClick = useCallback(
    (e: React.MouseEvent, entry: DirEntry, chainPaths?: string[]) => {
      const isMeta = e.metaKey || e.ctrlKey
      const isShift = e.shiftKey

      if (isMeta) {
        setSelectedPaths((prev) => {
          const next = new Set(prev)
          if (next.has(entry.path)) next.delete(entry.path)
          else next.add(entry.path)
          return next
        })
        lastClickedRef.current = entry.path
      } else if (isShift && lastClickedRef.current) {
        const startIdx = visibleEntries.findIndex((v) => v.entry.path === lastClickedRef.current)
        const endIdx = visibleEntries.findIndex((v) => v.entry.path === entry.path)
        if (startIdx >= 0 && endIdx >= 0) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
          const range = new Set(visibleEntries.slice(lo, hi + 1).map((v) => v.entry.path))
          setSelectedPaths(range)
        }
      } else {
        setSelectedPaths(new Set([entry.path]))
        lastClickedRef.current = entry.path
        if (entry.type === 'file') onOpenFile(entry.path)
        else handleToggleFolder(entry.path, chainPaths)
      }
      setFocusedPath(entry.path)
    },
    [visibleEntries, onOpenFile, handleToggleFolder]
  )

  return {
    selectedPaths,
    setSelectedPaths,
    focusedPath,
    setFocusedPath,
    treeContainerRef,
    handleEntryClick,
    getEffectiveSelection
  }
}
