import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildFileTree } from '@slayzone/ui'
import { parseUnifiedDiff } from './parse-diff'
import type { FileDiff as FileDiffType } from './parse-diff'
import { useGitDiffSnapshot, type GitDiffContextLines } from './git-diff-store'
import type { FileEntry } from './GitDiffPanel.types'
import { deriveStatus, getEntryPath } from './GitDiffPanel.utils'

interface UseGitDiffDataOptions {
  visible: boolean
  ignoreWhitespace: boolean
  contextLines: GitDiffContextLines
  pollIntervalMs: number
  fromSha: string | undefined
  toSha: string | undefined
  /** Called on each real working-tree snapshot change (used to refresh turns). */
  onSnapshotChange: () => void
}

/**
 * The git-diff read pipeline: shared snapshot fetch, diff parsing, staged /
 * unstaged entry + tree derivation, the diff lookup map, and eager untracked
 * diff fetching. Returns everything downstream hooks + the JSX need.
 */
export function useGitDiffData(
  targetPath: string | null,
  {
    visible,
    ignoreWhitespace,
    contextLines,
    pollIntervalMs,
    fromSha,
    toSha,
    onSnapshotChange
  }: UseGitDiffDataOptions
) {
  const [untrackedDiffs, setUntrackedDiffs] = useState<Map<string, FileDiffType>>(new Map())

  // Shared snapshot: identity-stable across panels hitting the same worktree,
  // refcounted timer, in-store snapshotsEqual short-circuit. contextLines is
  // part of the store key so toggling the display setting triggers a re-fetch
  // at the new context depth (skipping client-side collapse).
  const {
    snapshot,
    loading,
    error: fetchError,
    refresh
  } = useGitDiffSnapshot(targetPath, {
    visible,
    ignoreWhitespace,
    fromSha,
    toSha,
    contextLines,
    pollIntervalMs
  })

  // Snapshot identity is stable across polls when content unchanged
  // (snapshotsEqual short-circuit in the store), so this only fires on real
  // working-tree updates → re-runs the server-side turn filter without a tight
  // loop. onSnapshotChange is a stable callback so deps == [snapshot].
  useEffect(() => {
    if (!snapshot) return
    onSnapshotChange()
  }, [snapshot, onSnapshotChange])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // parseUnifiedDiff is backed by a global LRU keyed by the raw patch string, so
  // identical patches across panels + re-renders return the same array
  // reference. No useMemo wrapper needed — the cache already gives identity
  // stability across every caller.
  const unstagedFileDiffs = parseUnifiedDiff(snapshot?.unstagedPatch ?? '')
  const stagedFileDiffs = parseUnifiedDiff(snapshot?.stagedPatch ?? '')

  const unstagedEntries: FileEntry[] = useMemo(() => {
    if (!snapshot) return []
    return [
      ...snapshot.unstagedFiles.map((f) => ({
        path: f,
        status: deriveStatus(f, unstagedFileDiffs) as FileEntry['status'],
        source: 'unstaged' as const
      })),
      ...snapshot.untrackedFiles.map((f) => ({
        path: f,
        status: '?' as const,
        source: 'unstaged' as const
      }))
    ]
  }, [snapshot, unstagedFileDiffs])

  const stagedEntries: FileEntry[] = useMemo(() => {
    if (!snapshot) return []
    return snapshot.stagedFiles.map((f) => ({
      path: f,
      status: deriveStatus(f, stagedFileDiffs) as FileEntry['status'],
      source: 'staged' as const
    }))
  }, [snapshot, stagedFileDiffs])

  // Flat list for selection logic
  const flatEntries = useMemo(
    () => [...stagedEntries, ...unstagedEntries],
    [stagedEntries, unstagedEntries]
  )

  // Build trees for keyboard nav flattening (respecting collapsed folders)
  const stagedTree = useMemo(
    () => buildFileTree(stagedEntries, getEntryPath, { compress: true }),
    [stagedEntries]
  )
  const unstagedTree = useMemo(
    () => buildFileTree(unstagedEntries, getEntryPath, { compress: true }),
    [unstagedEntries]
  )

  const allDiffsMap = useMemo(() => {
    const map = new Map<string, FileDiffType>()
    for (const d of unstagedFileDiffs) map.set(`u:${d.path}`, d)
    for (const d of stagedFileDiffs) map.set(`s:${d.path}`, d)
    return map
  }, [unstagedFileDiffs, stagedFileDiffs])

  const getDiffForEntry = useCallback(
    (entry: FileEntry): FileDiffType | undefined => {
      const key = entry.source === 'staged' ? `s:${entry.path}` : `u:${entry.path}`
      return (
        allDiffsMap.get(key) ?? (entry.status === '?' ? untrackedDiffs.get(entry.path) : undefined)
      )
    },
    [allDiffsMap, untrackedDiffs]
  )

  // Eagerly fetch diffs for untracked files (for counts + preview)
  const prevUntrackedRef = useRef<string[]>([])
  useEffect(() => {
    if (!snapshot || !targetPath) return
    const curr = snapshot.untrackedFiles
    const prev = prevUntrackedRef.current
    prevUntrackedRef.current = curr

    const currSet = new Set(curr)
    const prevSet = new Set(prev)

    const removed = prev.filter((f) => !currSet.has(f))
    if (removed.length > 0) {
      setUntrackedDiffs((old) => {
        const next = new Map(old)
        for (const f of removed) next.delete(f)
        return next
      })
    }

    const added = curr.filter((f) => !prevSet.has(f))
    for (const filePath of added) {
      window.api.git
        .getUntrackedFileDiff(targetPath, filePath)
        .then((patch) => {
          const parsed = parseUnifiedDiff(patch)
          if (parsed.length > 0) {
            setUntrackedDiffs((old) => new Map(old).set(filePath, parsed[0]))
          }
        })
        .catch(() => {
          // ignore — file may be binary or inaccessible
        })
    }
  }, [snapshot, targetPath])

  const hasAnyChanges =
    !!snapshot &&
    (snapshot.files.length > 0 ||
      snapshot.unstagedPatch.trim().length > 0 ||
      snapshot.stagedPatch.trim().length > 0)

  return {
    snapshot,
    loading,
    fetchError,
    refresh,
    refreshRef,
    unstagedFileDiffs,
    stagedFileDiffs,
    unstagedEntries,
    stagedEntries,
    flatEntries,
    stagedTree,
    unstagedTree,
    getDiffForEntry,
    hasAnyChanges
  }
}
