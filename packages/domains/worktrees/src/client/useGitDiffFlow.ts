import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer, defaultRangeExtractor, type Range } from '@tanstack/react-virtual'
import type { FileDiff as FileDiffType } from './parse-diff'
import type { FileEntry, FlowRow } from './GitDiffPanel.types'
import { HUGE_FILE_THRESHOLD } from './GitDiffPanel.utils'

interface UseGitDiffFlowParams {
  flatEntries: FileEntry[]
  getDiffForEntry: (entry: FileEntry) => FileDiffType | undefined
  collapsedFiles: Set<string>
  selectedFile: { path: string; source: 'unstaged' | 'staged' } | null
  diffContinuousFlow: boolean
}

/**
 * Continuous-flow virtualized diff list: builds two virtual rows per file
 * (header + body), drives the sticky-header range extractor and the tanstack
 * row virtualizer, tracks user-toggled files (so huge-file auto-collapse won't
 * override intent), and scrolls the selected file into view.
 */
export function useGitDiffFlow({
  flatEntries,
  getDiffForEntry,
  collapsedFiles,
  selectedFile,
  diffContinuousFlow
}: UseGitDiffFlowParams) {
  // Tracks files the user has explicitly toggled (expanded or collapsed) so
  // auto-collapse won't override their intent on subsequent renders.
  const userToggledFilesRef = useRef<Set<string>>(new Set())

  // Prune userToggledFilesRef entries whose files no longer exist in the diff.
  // Otherwise the set grows unbounded over a long session as files churn.
  // Uses the same `${source}:${path}` key format as flowRows / collapsedFiles.
  useEffect(() => {
    const set = userToggledFilesRef.current
    if (set.size === 0) return
    const current = new Set<string>()
    for (const e of flatEntries) current.add(`${e.source}:${e.path}`)
    for (const key of set) {
      if (!current.has(key)) set.delete(key)
    }
  }, [flatEntries])

  // Continuous-flow entries (only files with diffs — matches what we render)
  const flowEntries = useMemo(
    () =>
      flatEntries
        .map((entry) => ({ entry, diff: getDiffForEntry(entry) }))
        .filter((x): x is { entry: FileEntry; diff: FileDiffType } => !!x.diff),
    [flatEntries, getDiffForEntry]
  )

  const flowRows = useMemo<FlowRow[]>(() => {
    const rows: FlowRow[] = []
    flowEntries.forEach(({ entry, diff }, fileIdx) => {
      const fileKey = `${entry.source}:${entry.path}`
      rows.push({ kind: 'header', fileKey, fileIdx, entry, diff })
      const userToggled = userToggledFilesRef.current.has(fileKey)
      const explicitlyCollapsed = collapsedFiles.has(fileKey)
      const autoCollapsed = !userToggled && diff.additions + diff.deletions > HUGE_FILE_THRESHOLD
      const collapsed = explicitlyCollapsed || autoCollapsed
      if (!collapsed) {
        rows.push({ kind: 'body', fileKey, fileIdx, entry, diff })
      }
    })
    return rows
  }, [flowEntries, collapsedFiles])

  // Indices of header rows — used by rangeExtractor for sticky behavior.
  const stickyHeaderIndices = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i < flowRows.length; i++) {
      if (flowRows[i].kind === 'header') out.push(i)
    }
    return out
  }, [flowRows])

  const stickyHeaderIndicesRef = useRef(stickyHeaderIndices)
  stickyHeaderIndicesRef.current = stickyHeaderIndices

  // Active sticky index = last header index at or before the current start.
  // Tracked via a ref (not state) so the rangeExtractor closure reads the
  // freshest value without invalidating the virtualizer config each render.
  const activeStickyIndexRef = useRef<number>(-1)

  const rangeExtractorSticky = useCallback((range: Range) => {
    const headers = stickyHeaderIndicesRef.current
    // Last header at or before range.startIndex — pins it while its body scrolls.
    // Binary search (upper_bound - 1): headers are in ascending order, and this
    // fires on every scroll tick so O(log N) matters for large file counts.
    let active = -1
    let lo = 0
    let hi = headers.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (headers[mid] <= range.startIndex) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) active = headers[lo - 1]
    activeStickyIndexRef.current = active
    const base = defaultRangeExtractor(range)
    if (active < 0) return base
    const set = new Set<number>(base)
    set.add(active)
    return [...set].sort((a, b) => a - b)
  }, [])

  // Virtualized scroll container for continuous flow
  const flowScrollRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: flowRows.length,
    getScrollElement: () => flowScrollRef.current,
    // Header rows are short (~40px); bodies are measured. Estimate splits the
    // difference — overscan + measureElement converge quickly.
    estimateSize: (index) => (flowRows[index]?.kind === 'header' ? 40 : 320),
    overscan: 2,
    getItemKey: (index) => {
      const r = flowRows[index]
      if (!r) return index
      return `${r.kind}:${r.fileKey}`
    },
    rangeExtractor: rangeExtractorSticky
  })

  // Scroll to selected file only when the user picks one — not on every poll
  // that rebuilds flowEntries identity. flowRowsRef lets the effect look up the
  // current header index without subscribing to array changes.
  const flowRowsRef = useRef(flowRows)
  flowRowsRef.current = flowRows
  useEffect(() => {
    if (!diffContinuousFlow || !selectedFile) return
    const key = `${selectedFile.source}:${selectedFile.path}`
    const idx = flowRowsRef.current.findIndex((r) => r.kind === 'header' && r.fileKey === key)
    if (idx < 0) return
    rowVirtualizer.scrollToIndex(idx, { align: 'start' })
  }, [selectedFile, diffContinuousFlow, rowVirtualizer])

  return {
    flowEntries,
    flowRows,
    rowVirtualizer,
    flowScrollRef,
    activeStickyIndexRef,
    userToggledFilesRef
  }
}
