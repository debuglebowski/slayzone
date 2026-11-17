import { useCallback, useEffect, useInsertionEffect, useMemo, useRef } from 'react'
import { buildFileTree } from '@slayzone/ui'
import { parseUnifiedDiff } from '@slayzone/diff-view'
import type { FileDiff as FileDiffType } from '@slayzone/diff-view'
import { useGitDiffSnapshot, type GitDiffContextLines } from './git-diff-store'
import type { FileEntry } from './GitDiffPanel.types'
import { useDiffTexts } from './useDiffTexts'
import { deriveStatus, getEntryPath } from './GitDiffPanel.utils'

/** An entry's key among the loaded per-file patches (`diff-text-loader`). */
function textKeyOf(entry: FileEntry): string {
  if (entry.status === '?') return `?:${entry.path}`
  return entry.source === 'staged' ? `s:${entry.path}` : `u:${entry.path}`
}

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

  // `refresh` is identity-stable (useGitDiffSnapshot), so the initial value already
  // covers every read. Insertion effect (same timing as useStableCallback) keeps the
  // ref current should that ever change, before any layout effect reads it.
  const refreshRef = useRef(refresh)
  useInsertionEffect(() => {
    refreshRef.current = refresh
  })

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

  // The per-file patches not in the snapshot's own text: the files a paged snapshot
  // deferred (budgeted batches; a large one by its first page, the rest on request)
  // and the untracked files' preview (each new file fetched once, in batches).
  const { loader: diffTexts, texts } = useDiffTexts(
    targetPath,
    { contextLines, ignoreWhitespace, fromSha, toSha },
    snapshot
  )

  const getDiffForEntry = useCallback(
    (entry: FileEntry): FileDiffType | undefined => {
      const key = entry.source === 'staged' ? `s:${entry.path}` : `u:${entry.path}`
      const inSnapshot = allDiffsMap.get(key)
      if (inSnapshot) return inSnapshot
      const loaded = texts.get(textKeyOf(entry))
      // parseUnifiedDiff's LRU (keyed by the text) keeps identities stable.
      return loaded?.text ? parseUnifiedDiff(loaded.text)[0] : undefined
    },
    [allDiffsMap, texts]
  )

  /** A file whose diff is still on its way (deferred or untracked, not loaded yet). */
  const isDiffPending = useCallback(
    (entry: FileEntry): boolean => {
      if (getDiffForEntry(entry)) return false
      const t = texts.get(textKeyOf(entry))
      if (t) return t.loading
      if (entry.status === '?') return true
      const d = snapshot?.deferred
      return !!d && (entry.source === 'staged' ? d.staged : d.unstaged).includes(entry.path)
    },
    [getDiffForEntry, texts, snapshot]
  )

  /** More of a large file's diff to load (its size), or null. */
  const getDiffRest = useCallback(
    (entry: FileEntry): { remainingBytes: number; loading: boolean; failed: boolean } | null => {
      const t = texts.get(textKeyOf(entry))
      return t?.rest
        ? { remainingBytes: t.rest.remainingBytes, loading: t.loading, failed: t.failed }
        : null
    },
    [texts]
  )

  const loadDiffRest = useCallback(
    (entry: FileEntry): Promise<void> =>
      diffTexts
        ? diffTexts.loadRest(textKeyOf(entry)).catch(() => {
            /* the entry shows the failure (`failed`) */
          })
        : Promise.resolve(),
    [diffTexts]
  )

  /** A file whose diff could not be read (its batch failed past the retries). */
  const isDiffFailed = useCallback(
    (entry: FileEntry): boolean => {
      const t = texts.get(textKeyOf(entry))
      return !!t?.failed && !t.rest && !getDiffForEntry(entry)
    },
    [texts, getDiffForEntry]
  )

  /** A file showing its last good diff because reading the new one failed. */
  const isDiffOutdated = useCallback(
    (entry: FileEntry): boolean => {
      const t = texts.get(textKeyOf(entry))
      // A failed "load rest" keeps its current first page (and its rest): not outdated.
      return !!t?.failed && !t.rest && t.text.length > 0
    },
    [texts]
  )

  const retryDiff = useCallback(
    (entry: FileEntry): void => diffTexts?.retry(textKeyOf(entry)),
    [diffTexts]
  )

  /** Ask again for every file whose diff could not be read, in batched requests. */
  const retryAllDiffs = useCallback((): void => diffTexts?.retryFailed(), [diffTexts])

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
    isDiffPending,
    getDiffRest,
    loadDiffRest,
    isDiffFailed,
    isDiffOutdated,
    retryDiff,
    retryAllDiffs,
    hasAnyChanges
  }
}
