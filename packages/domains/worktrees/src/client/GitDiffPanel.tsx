import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Plus, Minus, Undo2, ChevronRight, GitMerge, CheckCircle2, FileDiff, UnfoldVertical, FoldVertical } from 'lucide-react'
import { useVirtualizer, defaultRangeExtractor, type Range } from '@tanstack/react-virtual'
import {
  Button, FileTree, buildFileTree, flattenFileTree, fileTreeIndent, cn, buttonVariants,
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  PulseGrid
} from '@slayzone/ui'
import { useAppearance } from '@slayzone/settings/client'
import type { Task, MergeState } from '@slayzone/task/shared'
import { parseUnifiedDiff } from './parse-diff'
import type { FileDiff as FileDiffType } from './parse-diff'
import { DiffView } from './DiffView'
import { useAgentTurns, type AgentTurnRange } from '@slayzone/agent-turns/client'
import { useGitDiffSnapshot } from './git-diff-store'

interface GitDiffPanelProps {
  task: Task | null
  projectPath: string | null
  visible: boolean
  pollIntervalMs?: number
  // Merge mode integration
  mergeState?: MergeState | null
  onCommitAndContinueMerge?: () => Promise<void>
  onAbortMerge?: () => void
}

interface FileEntry {
  path: string
  status: 'M' | 'A' | 'D' | '?'
  source: 'unstaged' | 'staged'
}

interface ConfirmAction {
  title: string
  description: string
  actionLabel: string
  destructive?: boolean
  onConfirm: () => Promise<void> | void
}

function deriveStatus(path: string, diffs: FileDiffType[]): 'M' | 'A' | 'D' {
  const diff = diffs.find((d) => d.path === path)
  if (diff?.isNew) return 'A'
  if (diff?.isDeleted) return 'D'
  return 'M'
}

const STATUS_COLORS: Record<FileEntry['status'], string> = {
  M: 'text-yellow-600 dark:text-yellow-400',
  A: 'text-green-600 dark:text-green-400',
  D: 'text-red-600 dark:text-red-400',
  '?': 'text-muted-foreground'
}

const getEntryPath = (entry: FileEntry) => entry.path

function HorizontalResizeHandle({ onDrag }: { onDrag: (deltaX: number) => void }) {
  const isDragging = useRef(false)
  const startX = useRef(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      startX.current = e.clientX

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging.current) return
        const delta = e.clientX - startX.current
        startX.current = e.clientX
        onDrag(delta)
      }

      const handleMouseUp = () => {
        isDragging.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [onDrag]
  )

  return (
    <div
      className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
      onMouseDown={handleMouseDown}
    />
  )
}

const FileListItem = memo(function FileListItem({
  entry,
  displayName,
  selected,
  additions,
  deletions,
  onClick,
  onAction,
  onDiscard,
  itemRef,
  depth = 0
}: {
  entry: FileEntry
  displayName?: string
  selected: boolean
  additions?: number
  deletions?: number
  onClick: () => void
  onAction: () => void
  onDiscard?: () => void
  itemRef?: React.Ref<HTMLDivElement>
  depth?: number
}) {
  const hasCounts = additions != null || deletions != null

  return (
    <div
      ref={itemRef}
      className={cn(
        'group w-full text-left py-2 pr-3 flex items-center gap-1.5 text-xs font-mono hover:bg-muted/50 transition-colors cursor-pointer rounded',
        selected && 'bg-primary/10'
      )}
      style={{ paddingLeft: fileTreeIndent(depth) }}
      onClick={onClick}
    >
      <span className={cn('font-bold shrink-0 w-3 text-center', STATUS_COLORS[entry.status])}>
        {entry.status}
      </span>
      <span className="truncate min-w-0 flex-1">{displayName ?? entry.path}</span>
      {hasCounts && (
        <span className="shrink-0 text-[10px] tabular-nums space-x-1">
          {additions != null && additions > 0 && (
            <span className="text-green-600 dark:text-green-400">+{additions}</span>
          )}
          {deletions != null && deletions > 0 && (
            <span className="text-red-600 dark:text-red-400">-{deletions}</span>
          )}
        </span>
      )}
      {onDiscard && (
        <button
          className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation()
            onDiscard()
          }}
          title="Discard changes"
        >
          <Undo2 className="size-3.5" />
        </button>
      )}
      <button
        className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-foreground text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
        onClick={(e) => {
          e.stopPropagation()
          onAction()
        }}
        title={entry.source === 'unstaged' ? 'Stage file' : 'Unstage file'}
      >
        {entry.source === 'unstaged' ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}
      </button>
    </div>
  )
})

export interface GitDiffPanelHandle {
  refresh: () => void
}

export const GitDiffPanel = forwardRef<GitDiffPanelHandle, GitDiffPanelProps>(function GitDiffPanel({
  task,
  projectPath,
  visible,
  pollIntervalMs = 5000,
  mergeState,
  onCommitAndContinueMerge,
  onAbortMerge
}, ref) {
  const isMergeMode = mergeState === 'uncommitted'
  const { diffContextLines, diffIgnoreWhitespace, diffContinuousFlow, diffTreeCollapsed, diffSideBySide, diffWrap } = useAppearance()
  const targetPath = useMemo(() => task?.worktree_path ?? projectPath, [task?.worktree_path, projectPath])
  const [commitError, setCommitError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<{ path: string; source: 'unstaged' | 'staged' } | null>(null)
  const [fileListWidth, setFileListWidth] = useState(320)
  const [untrackedDiffs, setUntrackedDiffs] = useState<Map<string, FileDiffType>>(new Map())
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [stagedCollapsed, setStagedCollapsed] = useState(false)
  const [unstagedCollapsed, setUnstagedCollapsed] = useState(false)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(
    () => new Set(task?.diff_collapsed_files ?? [])
  )
  // Reset when switching tasks so we don't carry one task's collapsed set into another.
  const lastLoadedTaskIdRef = useRef<string | null>(task?.id ?? null)
  useEffect(() => {
    if (task?.id !== lastLoadedTaskIdRef.current) {
      lastLoadedTaskIdRef.current = task?.id ?? null
      setCollapsedFiles(new Set(task?.diff_collapsed_files ?? []))
    }
  }, [task?.id, task?.diff_collapsed_files])
  // Persist on change, debounced. Skip first render so we don't overwrite the
  // freshly-loaded value with itself.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didMountSaveRef = useRef(false)
  useEffect(() => {
    if (!task?.id) return
    if (!didMountSaveRef.current) { didMountSaveRef.current = true; return }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const taskId = task.id
    const arr = [...collapsedFiles]
    saveTimerRef.current = setTimeout(() => {
      void window.api.db.updateTask({ id: taskId, diffCollapsedFiles: arr })
    }, 400)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [collapsedFiles, task?.id])
  const [selectedTurnId, setSelectedTurnId] = useState<string | 'all'>('all')
  const turns = useAgentTurns(targetPath)
  const selectedTurn: AgentTurnRange | null = useMemo(
    () => (selectedTurnId === 'all' ? null : turns.find((t) => t.id === selectedTurnId) ?? null),
    [selectedTurnId, turns]
  )
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const confirmActionRef = useRef<ConfirmAction | null>(null)
  if (confirmAction) confirmActionRef.current = confirmAction
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const fileListRef = useRef<HTMLDivElement>(null)
  const selectedItemRef = useRef<HTMLDivElement>(null)
  const didInitSplitRef = useRef(false)

  // Resolve effective sha range for the current turn selection. For the first
  // turn (no prior snapshot), use the snapshot's parent commit (= HEAD at the
  // moment the snapshot was taken). git accepts `<sha>^` syntax, so the
  // fallback diffs against HEAD-at-snap-time, NOT the empty tree.
  const fromSha = selectedTurn
    ? (selectedTurn.prev_snapshot_sha ?? `${selectedTurn.snapshot_sha}^`)
    : undefined
  const toSha = selectedTurn ? selectedTurn.snapshot_sha : undefined

  // Shared snapshot: identity-stable across panels hitting the same worktree,
  // refcounted timer, in-store snapshotsEqual short-circuit. contextLines is
  // part of the store key so toggling the display setting triggers a re-fetch
  // at the new context depth (skipping client-side collapse).
  const { snapshot, loading, error: fetchError, refresh } = useGitDiffSnapshot(targetPath, {
    visible,
    ignoreWhitespace: diffIgnoreWhitespace,
    fromSha,
    toSha,
    contextLines: diffContextLines,
    pollIntervalMs,
  })
  const error = commitError ?? fetchError

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useImperativeHandle(ref, () => ({ refresh: () => { refreshRef.current() } }), [])

  // parseUnifiedDiff is backed by a global LRU keyed by the raw patch string,
  // so identical patches across panels + re-renders return the same array
  // reference. No useMemo wrapper needed — the cache already gives identity
  // stability across every caller.
  const unstagedFileDiffs = parseUnifiedDiff(snapshot?.unstagedPatch ?? '')
  const stagedFileDiffs = parseUnifiedDiff(snapshot?.stagedPatch ?? '')

  const unstagedEntries: FileEntry[] = useMemo(() => {
    if (!snapshot) return []
    return [
      ...snapshot.unstagedFiles.map((f) => ({ path: f, status: deriveStatus(f, unstagedFileDiffs) as FileEntry['status'], source: 'unstaged' as const })),
      ...snapshot.untrackedFiles.map((f) => ({ path: f, status: '?' as const, source: 'unstaged' as const }))
    ]
  }, [snapshot, unstagedFileDiffs])

  const stagedEntries: FileEntry[] = useMemo(() => {
    if (!snapshot) return []
    return snapshot.stagedFiles.map((f) => ({ path: f, status: deriveStatus(f, stagedFileDiffs) as FileEntry['status'], source: 'staged' as const }))
  }, [snapshot, stagedFileDiffs])

  // Flat list for selection logic
  const flatEntries = useMemo(() => [...stagedEntries, ...unstagedEntries], [stagedEntries, unstagedEntries])

  // Build trees for keyboard nav flattening (respecting collapsed folders)
  const stagedTree = useMemo(() => buildFileTree(stagedEntries, getEntryPath, { compress: true }), [stagedEntries])
  const unstagedTree = useMemo(() => buildFileTree(unstagedEntries, getEntryPath, { compress: true }), [unstagedEntries])

  // Invert expanded → collapsed for flattenFileTree
  const collapsedFolders = useMemo(() => {
    const allPaths = new Set<string>()
    function walk(nodes: typeof stagedTree) {
      for (const n of nodes) {
        if (n.type === 'folder') { allPaths.add(n.path); walk(n.children) }
      }
    }
    walk(stagedTree)
    walk(unstagedTree)
    const collapsed = new Set<string>()
    for (const p of allPaths) {
      if (!expandedFolders.has(p)) collapsed.add(p)
    }
    return collapsed
  }, [stagedTree, unstagedTree, expandedFolders])

  const visibleFlatEntries = useMemo(
    () => [
      ...flattenFileTree(stagedTree, collapsedFolders),
      ...flattenFileTree(unstagedTree, collapsedFolders)
    ],
    [stagedTree, unstagedTree, collapsedFolders]
  )

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Auto-expand all folders when new folders appear
  const prevFolderPathsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const allPaths = new Set<string>()
    function walk(nodes: typeof stagedTree) {
      for (const n of nodes) {
        if (n.type === 'folder') { allPaths.add(n.path); walk(n.children) }
      }
    }
    walk(stagedTree)
    walk(unstagedTree)
    const prev = prevFolderPathsRef.current
    const newPaths = [...allPaths].filter((p) => !prev.has(p))
    prevFolderPathsRef.current = allPaths
    if (newPaths.length > 0) {
      setExpandedFolders((old) => {
        const next = new Set(old)
        for (const p of newPaths) next.add(p)
        return next
      })
    }
  }, [stagedTree, unstagedTree])

  const allDiffsMap = useMemo(() => {
    const map = new Map<string, FileDiffType>()
    for (const d of unstagedFileDiffs) map.set(`u:${d.path}`, d)
    for (const d of stagedFileDiffs) map.set(`s:${d.path}`, d)
    return map
  }, [unstagedFileDiffs, stagedFileDiffs])

  const getDiffForEntry = useCallback((entry: FileEntry): FileDiffType | undefined => {
    const key = entry.source === 'staged' ? `s:${entry.path}` : `u:${entry.path}`
    return allDiffsMap.get(key) ?? (entry.status === '?' ? untrackedDiffs.get(entry.path) : undefined)
  }, [allDiffsMap, untrackedDiffs])

  const normalDiff = useMemo(() => {
    if (!selectedFile) return null
    const entry = flatEntries.find((f) => f.path === selectedFile.path && f.source === selectedFile.source)
    if (!entry) return null
    return getDiffForEntry(entry) ?? null
  }, [selectedFile, flatEntries, getDiffForEntry])

  const selectedDiff = normalDiff

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
      window.api.git.getUntrackedFileDiff(targetPath, filePath).then((patch) => {
        const parsed = parseUnifiedDiff(patch)
        if (parsed.length > 0) {
          setUntrackedDiffs((old) => new Map(old).set(filePath, parsed[0]))
        }
      }).catch(() => {
        // ignore — file may be binary or inaccessible
      })
    }
  }, [snapshot, targetPath])

  // Clear selection when file no longer exists
  useEffect(() => {
    if (selectedFile && !flatEntries.some((f) => f.path === selectedFile.path && f.source === selectedFile.source)) {
      setSelectedFile(null)
    }
  }, [flatEntries, selectedFile])

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

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedFile])

  // Continuous-flow entries (only files with diffs — matches what we render)
  const flowEntries = useMemo(
    () => flatEntries.map((entry) => ({ entry, diff: getDiffForEntry(entry) }))
      .filter((x): x is { entry: FileEntry; diff: FileDiffType } => !!x.diff),
    [flatEntries, getDiffForEntry]
  )

  // Fix 6 — Huge files stall continuous-flow because DiffView's line-level
  // virtualizer falls back to plain rendering when nested inside this outer
  // row virtualizer (see findScrollParent in DiffView.tsx). Threading an outer
  // scroll parent into the inner virtualizer requires reworking DiffView's
  // scroll-parent discovery + scrollMargin handling for nested virtualizers —
  // a future improvement. For now, auto-collapse huge files on first sight so
  // the user pays the render cost only when they opt in by expanding.
  const HUGE_FILE_THRESHOLD = 1000
  // Tracks files the user has explicitly toggled (expanded or collapsed) so
  // auto-collapse won't override their intent on subsequent renders.
  const userToggledFilesRef = useRef<Set<string>>(new Set())

  // Build two virtual rows per file (header + body) so headers can be sticky
  // via the tanstack-virtual sticky pattern: rangeExtractor always includes
  // the active sticky index, and that row renders with `position: sticky`
  // instead of `position: absolute`. Collapsed files emit only a header row
  // (their body contributes nothing to total height).
  type FlowRow =
    | { kind: 'header'; fileKey: string; fileIdx: number; entry: FileEntry; diff: FileDiffType }
    | { kind: 'body'; fileKey: string; fileIdx: number; entry: FileEntry; diff: FileDiffType }

  const flowRows = useMemo<FlowRow[]>(() => {
    const rows: FlowRow[] = []
    flowEntries.forEach(({ entry, diff }, fileIdx) => {
      const fileKey = `${entry.source}:${entry.path}`
      rows.push({ kind: 'header', fileKey, fileIdx, entry, diff })
      const userToggled = userToggledFilesRef.current.has(fileKey)
      const explicitlyCollapsed = collapsedFiles.has(fileKey)
      const autoCollapsed = !userToggled && (diff.additions + diff.deletions) > HUGE_FILE_THRESHOLD
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
    estimateSize: (index) => flowRows[index]?.kind === 'header' ? 40 : 320,
    overscan: 2,
    getItemKey: (index) => {
      const r = flowRows[index]
      if (!r) return index
      return `${r.kind}:${r.fileKey}`
    },
    rangeExtractor: rangeExtractorSticky,
  })

  // Scroll to selected file only when the user picks one — not on every poll
  // that rebuilds flowEntries identity. flowRowsRef lets the effect look up
  // the current header index without subscribing to array changes.
  const flowRowsRef = useRef(flowRows)
  flowRowsRef.current = flowRows
  useEffect(() => {
    if (!diffContinuousFlow || !selectedFile) return
    const key = `${selectedFile.source}:${selectedFile.path}`
    const idx = flowRowsRef.current.findIndex((r) => r.kind === 'header' && r.fileKey === key)
    if (idx < 0) return
    rowVirtualizer.scrollToIndex(idx, { align: 'start' })
  }, [selectedFile, diffContinuousFlow, rowVirtualizer])

  const handleBulkAction = useCallback(async (action: 'stageAll' | 'unstageAll') => {
    if (!targetPath) return
    try {
      if (action === 'stageAll') {
        await window.api.git.stageAll(targetPath)
      } else {
        await window.api.git.unstageAll(targetPath)
      }
      await refreshRef.current()
    } catch {
      // silently fail — next poll will correct state
    }
  }, [targetPath])

  const handleStageAction = useCallback(async (filePath: string, source: 'unstaged' | 'staged') => {
    if (!targetPath) return
    try {
      if (source === 'unstaged') {
        await window.api.git.stageFile(targetPath, filePath)
      } else {
        await window.api.git.unstageFile(targetPath, filePath)
      }
      await refreshRef.current()
    } catch {
      // silently fail — next poll will correct state
    }
  }, [targetPath])

  const handleDiscardFile = useCallback(async (filePath: string, untracked?: boolean) => {
    if (!targetPath) return
    try {
      await window.api.git.discardFile(targetPath, filePath, untracked)
      await refreshRef.current()
    } catch {
      // silently fail — next poll will correct state
    }
  }, [targetPath])

  const handleStageFolderAction = useCallback(async (folderPath: string, source: 'unstaged' | 'staged') => {
    if (!targetPath) return
    try {
      if (source === 'unstaged') {
        await window.api.git.stageFile(targetPath, folderPath)
      } else {
        await window.api.git.unstageFile(targetPath, folderPath)
      }
      await refreshRef.current()
    } catch {
      // silently fail — next poll will correct state
    }
  }, [targetPath])

  const handleCommit = useCallback(async () => {
    if (!targetPath || !commitMessage.trim() || stagedEntries.length === 0) return
    setCommitting(true)
    try {
      await window.api.git.commitFiles(targetPath, commitMessage.trim())
      setCommitMessage('')
      await refreshRef.current()
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err))
    } finally {
      setCommitting(false)
    }
  }, [targetPath, commitMessage, stagedEntries.length])

  const handleSelectFile = useCallback((path: string, source: 'unstaged' | 'staged') => {
    setSelectedFile({ path, source })
  }, [])

  const handleResize = useCallback((delta: number) => {
    setFileListWidth((w) => Math.max(50, w + delta))
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()

    const currentIdx = selectedFile
      ? visibleFlatEntries.findIndex((f) => f.path === selectedFile.path && f.source === selectedFile.source)
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
  }, [selectedFile, visibleFlatEntries])

  const hasAnyChanges = !!snapshot && (
    snapshot.files.length > 0 ||
    snapshot.unstagedPatch.trim().length > 0 ||
    snapshot.stagedPatch.trim().length > 0
  )

  useEffect(() => {
    if (!hasAnyChanges || didInitSplitRef.current) return
    const containerWidth = splitContainerRef.current?.clientWidth ?? 0
    if (containerWidth <= 0) return
    didInitSplitRef.current = true
    setFileListWidth(Math.max(50, containerWidth / 2))
  }, [hasAnyChanges])

  const isSelected = (entry: FileEntry) =>
    selectedFile?.path === entry.path && selectedFile?.source === entry.source

  const renderFileItem = useCallback((entry: FileEntry, { name, depth }: { name: string; depth: number }) => {
    const diff = getDiffForEntry(entry)
    const selected = isSelected(entry)
    const canDiscard = entry.source === 'unstaged'
    return (
      <FileListItem
        entry={entry}
        displayName={name}
        selected={selected}
        additions={diff?.additions}
        deletions={diff?.deletions}
        onClick={() => handleSelectFile(entry.path, entry.source)}
        onAction={() => handleStageAction(entry.path, entry.source)}
        onDiscard={canDiscard ? () => setConfirmAction({
          title: 'Discard Changes',
          description: `Discard all changes to "${entry.path}"? This cannot be undone.`,
          actionLabel: 'Discard',
          destructive: true,
          onConfirm: () => handleDiscardFile(entry.path, entry.status === '?')
        }) : undefined}
        itemRef={selected ? selectedItemRef : undefined}
        depth={depth}
      />
    )
  }, [getDiffForEntry, selectedFile, handleSelectFile, handleStageAction, handleDiscardFile])

  const stagedFolderActions = useCallback((folder: { name: string; path: string }) => (
    <span
      className="shrink-0 opacity-0 group-hover/folder:opacity-100 hover:text-foreground text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
      onClick={(e) => { e.stopPropagation(); handleStageFolderAction(folder.path, 'staged') }}
      title="Unstage folder"
    >
      <Minus className="size-3.5" />
    </span>
  ), [handleStageFolderAction])

  const unstagedFolderActions = useCallback((folder: { name: string; path: string }) => (
    <>
      <span
        className="shrink-0 opacity-0 group-hover/folder:opacity-100 hover:text-destructive text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
        onClick={(e) => { e.stopPropagation(); setConfirmAction({
          title: 'Discard Folder Changes',
          description: `Discard all changes in "${folder.name}"? This cannot be undone.`,
          actionLabel: 'Discard',
          destructive: true,
          onConfirm: () => handleDiscardFile(folder.path)
        }) }}
        title="Discard folder changes"
      >
        <Undo2 className="size-3.5" />
      </span>
      <span
        className="shrink-0 opacity-0 group-hover/folder:opacity-100 hover:text-foreground text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
        onClick={(e) => { e.stopPropagation(); handleStageFolderAction(folder.path, 'unstaged') }}
        title="Stage folder"
      >
        <Plus className="size-3.5" />
      </span>
    </>
  ), [handleStageFolderAction, handleDiscardFile])

  const commitInputBlock = (
    <div className="shrink-0 p-2 border-t space-y-1.5">
      <textarea
        className="w-full resize-none rounded border bg-transparent px-2 py-1.5 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        style={{ maxHeight: 120 }}
        placeholder="Commit message"
        rows={3}
        value={commitMessage}
        onChange={(e) => {
          setCommitMessage(e.target.value)
          const el = e.target
          el.style.height = 'auto'
          el.style.height = `${Math.min(el.scrollHeight, 120)}px`
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            handleCommit()
          }
        }}
      />
      {isMergeMode && onCommitAndContinueMerge ? (
        <Button
          variant="default"
          size="sm"
          className="w-full h-7 text-xs"
          disabled={committing}
          onClick={async () => {
            setCommitting(true)
            try { await onCommitAndContinueMerge() }
            catch (err) { setCommitError(err instanceof Error ? err.message : String(err)) }
            finally { setCommitting(false) }
          }}
        >
          {committing ? 'Committing...' : 'Commit & Continue Merge'}
        </Button>
      ) : (
        <Button
          variant="default"
          size="sm"
          className="w-full h-7 text-xs"
          disabled={!commitMessage.trim() || stagedEntries.length === 0 || committing}
          onClick={handleCommit}
        >
          {committing ? 'Committing...' : `Commit${stagedEntries.length > 0 ? ` (${stagedEntries.length} staged)` : ''}`}
        </Button>
      )}
    </div>
  )

  return (
    <div data-testid="git-diff-panel" className="h-full flex flex-col">
      {/* Merge-mode banner */}
      {isMergeMode && (
        <div className="shrink-0 px-4 py-2 bg-purple-500/10 border-b flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GitMerge className="h-3.5 w-3.5 text-purple-400" />
            <span className="text-xs font-medium text-purple-300">Stage and commit your changes to continue the merge</span>
          </div>
          <div className="flex items-center gap-1.5">
            {onAbortMerge && (
              <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setConfirmAction({
                title: 'Abort Merge',
                description: 'Abort the current merge? All merge progress will be lost.',
                actionLabel: 'Abort',
                destructive: true,
                onConfirm: onAbortMerge
              })}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Empty states */}
      {!targetPath && (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-muted-foreground">
            Set a project path or worktree to view git diff
          </p>
        </div>
      )}

      {targetPath && !error && loading && !snapshot && (
        <div className="flex-1 min-h-0">
          <PulseGrid />
        </div>
      )}

      {targetPath && error && (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {targetPath && !error && !loading && snapshot && !hasAnyChanges && (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <CheckCircle2 className="size-10 opacity-30" />
            <div className="text-center">
              <p className="text-base font-medium text-foreground/60">Working tree clean</p>
              <p className="text-sm mt-0.5 opacity-60">No uncommitted changes</p>
            </div>
          </div>
        </div>
      )}

      {/* Main content: horizontal split */}
      {targetPath && !error && snapshot && hasAnyChanges && (
        <div ref={splitContainerRef} className="flex-1 min-h-0 flex">
          {/* Left: file lists + commit */}
          {!diffTreeCollapsed && (
          <div
            className="shrink-0 flex flex-col min-h-0 border-r"
            style={{ width: fileListWidth }}
          >
            <div
              ref={fileListRef}
              className="flex-1 min-h-0 overflow-y-auto outline-none"
              tabIndex={0}
              onKeyDown={handleKeyDown}
            >
            {/* Staged section */}
            {stagedEntries.length > 0 && (
              <div>
                <div
                  className="h-[30px] px-3 text-[11px] font-medium text-muted-foreground uppercase tracking-wide bg-muted border-b sticky top-0 z-10 flex items-center justify-between cursor-pointer select-none"
                  onClick={() => setStagedCollapsed((v) => !v)}
                >
                  <span className="flex items-center gap-1">
                    <ChevronRight className={cn('size-3 transition-transform', !stagedCollapsed && 'rotate-90')} />
                    Staged ({stagedEntries.length})
                  </span>
                  <button
                    className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded hover:bg-accent"
                    onClick={(e) => { e.stopPropagation(); setConfirmAction({
                      title: 'Unstage All',
                      description: `Unstage all ${stagedEntries.length} files?`,
                      actionLabel: 'Unstage All',
                      onConfirm: () => handleBulkAction('unstageAll')
                    }) }}
                    title="Unstage all"
                  >
                    <Minus className="size-3.5" />
                  </button>
                </div>
                {!stagedCollapsed && (
                  <FileTree
                    items={stagedEntries}
                    getPath={getEntryPath}
                    compress
                    expandedFolders={expandedFolders}
                    onToggleFolder={toggleFolder}
                    renderFile={renderFileItem}
                    folderActions={stagedFolderActions}
                  />
                )}
              </div>
            )}

            {/* Unstaged section */}
            {unstagedEntries.length > 0 && (
              <div>
                <div
                  className="h-[30px] px-3 text-[11px] font-medium text-muted-foreground uppercase tracking-wide bg-muted border-b sticky top-0 z-10 flex items-center justify-between cursor-pointer select-none"
                  onClick={() => setUnstagedCollapsed((v) => !v)}
                >
                  <span className="flex items-center gap-1">
                    <ChevronRight className={cn('size-3 transition-transform', !unstagedCollapsed && 'rotate-90')} />
                    Unstaged ({unstagedEntries.length})
                  </span>
                  <button
                    className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded hover:bg-accent"
                    onClick={(e) => { e.stopPropagation(); setConfirmAction({
                      title: 'Stage All',
                      description: `Stage all ${unstagedEntries.length} files?`,
                      actionLabel: 'Stage All',
                      onConfirm: () => handleBulkAction('stageAll')
                    }) }}
                    title="Stage all"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </div>
                {!unstagedCollapsed && (
                  <FileTree
                    items={unstagedEntries}
                    getPath={getEntryPath}
                    compress
                    expandedFolders={expandedFolders}
                    onToggleFolder={toggleFolder}
                    renderFile={renderFileItem}
                    folderActions={unstagedFolderActions}
                  />
                )}
              </div>
            )}
            </div>

            {/* Commit input — pinned to bottom of sidebar */}
            {commitInputBlock}
          </div>
          )}

          {/* Resize handle */}
          {!diffTreeCollapsed && <HorizontalResizeHandle onDrag={handleResize} />}

          {/* Right: diff viewer */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {/* Turns chip row — replaces the legacy "X changed files" header. Always
                rendered when in continuous-flow or with a selected file, so the user
                always has an All toggle even before any turn snapshots exist. */}
            {diffContinuousFlow && (
              <div className="shrink-0 h-9 flex items-center gap-1.5 px-2 bg-muted/30 border-b overflow-x-auto">
                <button
                  onClick={() => setSelectedTurnId('all')}
                  className={cn(
                    'shrink-0 px-3 h-6 rounded-full text-[11px] font-medium border transition-colors',
                    selectedTurnId === 'all'
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background hover:bg-muted text-foreground border-border'
                  )}
                >
                  All turns
                </button>
                {[...turns].reverse().map((t, idx) => {
                  // Newest = highest number. With turns sorted oldest→newest,
                  // reversed iteration starts at newest (idx 0) → n = length - idx.
                  const n = turns.length - idx
                  const active = selectedTurnId === t.id
                  const tip = [
                    t.task_title ? `Task: ${t.task_title}` : null,
                    t.prompt_preview ? `Prompt: ${t.prompt_preview}` : null,
                  ].filter(Boolean).join('\n') || `Turn ${n}`
                  return (
                    <button
                      key={t.id}
                      onClick={() => setSelectedTurnId(t.id)}
                      title={tip}
                      className={cn(
                        'shrink-0 px-3 h-6 rounded-full text-[11px] font-medium border transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background hover:bg-muted text-foreground border-border'
                      )}
                    >
                      Turn {n}
                    </button>
                  )
                })}
                <div className="ml-auto flex items-center gap-0.5 shrink-0 sticky right-0 bg-muted/30 pl-1">
                  <button
                    onClick={() => {
                      // Mark every current file as user-toggled so auto-collapse
                      // of huge files stays overridden after Expand all.
                      for (const e of flatEntries) userToggledFilesRef.current.add(`${e.source}:${e.path}`)
                      setCollapsedFiles(new Set())
                    }}
                    title="Expand all files"
                    className="size-6 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <UnfoldVertical className="size-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      for (const e of flatEntries) userToggledFilesRef.current.add(`${e.source}:${e.path}`)
                      setCollapsedFiles(new Set(flatEntries.map((e) => `${e.source}:${e.path}`)))
                    }}
                    title="Collapse all files"
                    className="size-6 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <FoldVertical className="size-3.5" />
                  </button>
                </div>
              </div>
            )}
            {/* Body */}
            {diffContinuousFlow ? (
              <div className="flex-1 min-h-0 flex flex-col pt-2">
                {flowEntries.length === 0 ? (
                  <div className="flex-1 min-h-0 flex items-center justify-center p-6">
                    <p className="text-xs text-muted-foreground">No changes</p>
                  </div>
                ) : (
                  <div
                    ref={flowScrollRef}
                    className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-2"
                  >
                    <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                      {rowVirtualizer.getVirtualItems().map((v) => {
                        const row = flowRows[v.index]
                        if (!row) return null
                        const { entry, diff, fileKey } = row
                        const userToggled = userToggledFilesRef.current.has(fileKey)
                        const explicitlyCollapsed = collapsedFiles.has(fileKey)
                        const autoCollapsed = !userToggled && (diff.additions + diff.deletions) > HUGE_FILE_THRESHOLD
                        const collapsed = explicitlyCollapsed || autoCollapsed
                        const isActiveSticky = v.index === activeStickyIndexRef.current
                        const isHeader = row.kind === 'header'

                        // Sticky pattern: the active header uses `position: sticky`
                        // (no transform) so it pins at top: 0 of the scroll parent
                        // while its body scrolls. All other rows use the standard
                        // `position: absolute` + translateY placement.
                        const style: React.CSSProperties = isHeader && isActiveSticky
                          ? {
                              position: 'sticky',
                              top: 0,
                              left: 0,
                              right: 0,
                              zIndex: 20,
                            }
                          : {
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              right: 0,
                              transform: `translateY(${v.start}px)`,
                            }

                        if (isHeader) {
                          return (
                            <div
                              key={v.key}
                              data-index={v.index}
                              ref={rowVirtualizer.measureElement}
                              style={collapsed ? { ...style, paddingBottom: 8 } : style}
                            >
                              <div
                                className={cn(
                                  'h-10 px-3 text-xs font-medium bg-muted border border-border flex items-center gap-2 cursor-pointer select-none hover:bg-muted/80',
                                  collapsed ? 'rounded-lg' : 'rounded-t-lg'
                                )}
                                onClick={() => {
                                  // Record user intent so auto-collapse won't override the toggle.
                                  userToggledFilesRef.current.add(fileKey)
                                  setCollapsedFiles((prev) => {
                                    const next = new Set(prev)
                                    // If currently collapsed (explicitly or auto), expand → remove from set.
                                    // Otherwise collapse → add to set.
                                    if (collapsed) next.delete(fileKey); else next.add(fileKey)
                                    return next
                                  })
                                }}
                              >
                                <ChevronRight className={cn('size-3 shrink-0 transition-transform text-muted-foreground', !collapsed && 'rotate-90')} />
                                <span className={cn('font-bold', STATUS_COLORS[entry.status])}>{entry.status}</span>
                                <span className="truncate">{entry.path}</span>
                                <span className="ml-auto text-[10px] text-muted-foreground tabular-nums space-x-1">
                                  {diff.additions > 0 && <span className="text-green-600 dark:text-green-400">+{diff.additions}</span>}
                                  {diff.deletions > 0 && <span className="text-red-600 dark:text-red-400">-{diff.deletions}</span>}
                                </span>
                              </div>
                            </div>
                          )
                        }

                        // Body row — only emitted for expanded files.
                        return (
                          <div
                            key={v.key}
                            data-index={v.index}
                            ref={rowVirtualizer.measureElement}
                            style={{ ...style, paddingBottom: 8 }}
                          >
                            <div className="overflow-hidden rounded-b-lg border-x border-b border-border bg-card shadow-sm">
                              <DiffView diff={diff} sideBySide={diffSideBySide} wrap={diffWrap} contextLines={diffContextLines} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                {!selectedFile && (
                  <div className="flex-1 flex items-center justify-center p-6">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <FileDiff className="size-10 opacity-30" />
                      <div className="text-center">
                        <p className="text-base font-medium text-foreground/60">No file selected</p>
                        <p className="text-sm mt-0.5 opacity-60">Pick a file from the list to view its diff</p>
                      </div>
                    </div>
                  </div>
                )}
                {selectedFile && !selectedDiff && (
                  <div className="flex-1 flex items-center justify-center p-6">
                    <p className="text-xs text-muted-foreground">
                      {flatEntries.find((f) => f.path === selectedFile.path && f.source === selectedFile.source)?.status === '?'
                        ? 'Loading...'
                        : 'No diff content'}
                    </p>
                  </div>
                )}
                {selectedFile && selectedDiff && (
                  <div className="flex-1 min-h-0 overflow-auto">
                    <DiffView diff={selectedDiff} sideBySide={diffSideBySide} wrap={diffWrap} contextLines={diffContextLines} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Confirmation dialog for destructive actions */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmActionRef.current?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmActionRef.current?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirmActionRef.current?.destructive ? buttonVariants({ variant: 'destructive' }) : undefined}
              onClick={() => confirmActionRef.current?.onConfirm()}
            >
              {confirmActionRef.current?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
