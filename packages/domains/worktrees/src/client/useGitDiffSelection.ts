import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileDiff as FileDiffType } from './parse-diff'
import type { FileEntry } from './GitDiffPanel.types'

type SelectedFile = { path: string; source: 'unstaged' | 'staged' } | null

interface UseGitDiffSelectionParams {
  flatEntries: FileEntry[]
  visibleFlatEntries: FileEntry[]
  diffContinuousFlow: boolean
  getDiffForEntry: (entry: FileEntry) => FileDiffType | undefined
}

/**
 * Single-file selection for non-continuous-flow mode: which file is shown in the
 * right pane, keyboard up/down navigation, auto-keep-selected, scroll-into-view,
 * and the resolved diff for the selection.
 */
export function useGitDiffSelection({
  flatEntries,
  visibleFlatEntries,
  diffContinuousFlow,
  getDiffForEntry
}: UseGitDiffSelectionParams) {
  const [selectedFile, setSelectedFile] = useState<SelectedFile>(null)
  const selectedItemRef = useRef<HTMLDivElement>(null)

  const normalDiff = useMemo(() => {
    if (!selectedFile) return null
    const entry = flatEntries.find(
      (f) => f.path === selectedFile.path && f.source === selectedFile.source
    )
    if (!entry) return null
    return getDiffForEntry(entry) ?? null
  }, [selectedFile, flatEntries, getDiffForEntry])

  const selectedDiff = normalDiff

  // Keep a file selected at all times in non-continuous-flow mode — the right
  // pane needs SOMETHING to render. Auto-pick the first entry on mount, after a
  // selection vanishes (file committed/discarded), and any time the list grows
  // from empty. Continuous-flow doesn't depend on selection so it stays opt-in.
  useEffect(() => {
    if (diffContinuousFlow) return
    if (flatEntries.length === 0) {
      if (selectedFile) setSelectedFile(null)
      return
    }
    const stillValid =
      selectedFile &&
      flatEntries.some((f) => f.path === selectedFile.path && f.source === selectedFile.source)
    if (!stillValid) {
      setSelectedFile({ path: flatEntries[0].path, source: flatEntries[0].source })
    }
  }, [flatEntries, selectedFile, diffContinuousFlow])

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedFile])

  const handleSelectFile = useCallback((path: string, source: 'unstaged' | 'staged') => {
    setSelectedFile({ path, source })
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()

      const currentIdx = selectedFile
        ? visibleFlatEntries.findIndex(
            (f) => f.path === selectedFile.path && f.source === selectedFile.source
          )
        : -1

      let nextIdx: number
      if (e.key === 'ArrowDown') {
        nextIdx = currentIdx < visibleFlatEntries.length - 1 ? currentIdx + 1 : 0
      } else {
        nextIdx = currentIdx > 0 ? currentIdx - 1 : visibleFlatEntries.length - 1
      }

      const next = visibleFlatEntries[nextIdx]
      if (next) {
        setSelectedFile({ path: next.path, source: next.source })
      }
    },
    [selectedFile, visibleFlatEntries]
  )

  return {
    selectedFile,
    setSelectedFile,
    handleSelectFile,
    handleKeyDown,
    selectedItemRef,
    selectedDiff
  }
}
