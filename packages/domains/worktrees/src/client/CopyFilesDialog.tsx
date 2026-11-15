import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import { Loader2, Folder, File, ChevronRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import type { IgnoredEntry, WorktreeCopyPreset } from '../shared/types'
import { DEFAULT_COPY_PRESETS } from '../shared/types'
import {
  ancestorRootOf,
  chainDirs,
  indexSelection,
  type Selection,
  type SelectionIndex,
  selectedCountOf,
  stateOf,
  toggleSelection
} from './CopyFilesDialog.utils'
import type { IgnoredDir } from './ignored-tree-loader'
import { useIgnoredTree } from './useIgnoredTree'

export type CopyChoice = { mode: 'none' } | { mode: 'custom'; paths: string[] }

interface CopyFilesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoPath: string
  onConfirm: (choice: CopyChoice) => void
}

const NO_SELECTION: Selection = new Map()

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const val = bytes / Math.pow(1024, i)
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`
}

interface TreeProps {
  dirs: ReadonlyMap<string, IgnoredDir>
  selection: SelectionIndex
  expanded: Set<string>
  onToggle: (entry: IgnoredEntry) => void
  onToggleExpand: (path: string) => void
  onLoadMore: (dir: string) => void
}

/** The rows after a folder's loaded children: loading, a way to the next page, or a retry. */
function DirFooter({
  dir,
  state,
  depth,
  onLoadMore
}: {
  dir: string
  state: IgnoredDir | undefined
  depth: number
  onLoadMore: (dir: string) => void
}) {
  const pad = { paddingLeft: `${depth * 16 + 8 + 22}px` }
  if (!state || (state.loading && state.items.length === 0))
    return (
      <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground" style={pad}>
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading…
      </div>
    )
  if (state.failed)
    return (
      <button
        type="button"
        className="py-1 text-xs text-muted-foreground hover:text-foreground"
        style={pad}
        onClick={() => onLoadMore(dir)}
      >
        Could not load. Retry
      </button>
    )
  if (state.nextCursor !== null)
    return (
      <button
        type="button"
        className="py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        style={pad}
        disabled={state.loading}
        onClick={() => onLoadMore(dir)}
      >
        Load more
      </button>
    )
  return null
}

function NodeRow({ node, depth, ...tree }: TreeProps & { node: IgnoredEntry; depth: number }) {
  const state = stateOf(tree.selection, node)
  const isExpanded = tree.expanded.has(node.path)
  const checked: boolean | 'indeterminate' =
    state === 'checked' ? true : state === 'indeterminate' ? 'indeterminate' : false
  const selectedCount = selectedCountOf(tree.selection, node)
  const children = node.isDirectory && isExpanded ? tree.dirs.get(node.path) : undefined

  return (
    <>
      <div
        className="flex items-center gap-2 py-1 rounded hover:bg-muted transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: 8 }}
      >
        <Checkbox checked={checked} onCheckedChange={() => tree.onToggle(node)} />
        {node.isDirectory ? (
          <button
            type="button"
            onClick={() => tree.onToggleExpand(node.path)}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform',
                isExpanded && 'rotate-90'
              )}
            />
            <Folder className="h-3.5 w-3.5 text-blue-400 shrink-0" />
            <span className="text-sm font-mono flex-1 truncate">{node.name}/</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {node.fileCount} file{node.fileCount !== 1 ? 's' : ''}
              {selectedCount > 0 && selectedCount < node.fileCount && (
                <span className="text-primary"> ({selectedCount} selected)</span>
              )}
            </span>
          </button>
        ) : (
          <span className="flex items-center gap-1.5 flex-1 min-w-0">
            <span className="w-3.5" />
            <File className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm font-mono flex-1 truncate">{node.name}</span>
            {node.size > 0 && (
              <span className="text-xs text-muted-foreground shrink-0">
                {formatBytes(node.size)}
              </span>
            )}
          </span>
        )}
      </div>
      {node.isDirectory && isExpanded && (
        <>
          {children?.items.map((child) => (
            <NodeRow key={child.path} node={child} depth={depth + 1} {...tree} />
          ))}
          <DirFooter
            dir={node.path}
            state={children}
            depth={depth + 1}
            onLoadMore={tree.onLoadMore}
          />
        </>
      )}
    </>
  )
}

export function CopyFilesDialog({ open, onOpenChange, repoPath, onConfirm }: CopyFilesDialogProps) {
  const trpc = useTRPC()
  const [presets, setPresets] = useState<WorktreeCopyPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState<string>('')
  const [selected, setSelected] = useState<Selection>(NO_SELECTION)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Bumped by every selection change; an async selection (a preset's match, an
  // uncheck that first loads folders) applies only if nothing changed meanwhile.
  const generation = useRef(0)

  // Presets settings + the ignored-file index. Both follow `open`: a fresh index
  // (a new scan) each time the dialog opens, as the whole-tree query refetched.
  const presetsQuery = useQuery(
    trpc.settings.get.queryOptions({ key: 'worktree_copy_presets' }, { enabled: open })
  )
  const { loader, snapshot } = useIgnoredTree(repoPath, open)
  const loading = open && snapshot.status === 'loading'
  const ready = open && snapshot.status === 'ready'
  const root = snapshot.dirs.get('')

  // Reset transient selection/expansion on open. Runs while rendering whenever
  // `open` changes (null = not yet synced, so the first render syncs too), so no
  // commit shows the previous open's state.
  const [resetForOpen, setResetForOpen] = useState<boolean | null>(null)
  if (resetForOpen !== open) {
    setResetForOpen(open)
    if (open) {
      setExpanded(new Set())
      setSelected(NO_SELECTION)
    }
  }

  const presetsInput = {
    open,
    isFetched: presetsQuery.isFetched,
    data: presetsQuery.data
  }
  const [presetsSyncedFor, setPresetsSyncedFor] = useState<typeof presetsInput | null>(null)
  if (
    presetsSyncedFor === null ||
    presetsSyncedFor.open !== presetsInput.open ||
    presetsSyncedFor.isFetched !== presetsInput.isFetched ||
    presetsSyncedFor.data !== presetsInput.data
  ) {
    setPresetsSyncedFor(presetsInput)
    if (open && presetsQuery.isFetched) {
      let list: WorktreeCopyPreset[]
      try {
        const raw = presetsQuery.data
        const parsed = raw ? (JSON.parse(raw) as WorktreeCopyPreset[]) : null
        list = parsed && parsed.length > 0 ? parsed : DEFAULT_COPY_PRESETS
      } catch {
        list = DEFAULT_COPY_PRESETS
      }
      setPresets(list)
      setSelectedPresetId(list[0].id)
    }
  }

  // The selection follows the selected preset: matched by the index (every ignored
  // file, at any depth) whenever the preset, the preset list or the index changes.
  // A manual toggle switches to 'custom', which matches no preset.
  useEffect(() => {
    const preset = ready ? presets.find((p) => p.id === selectedPresetId) : undefined
    if (!preset || !loader) return
    // A newer change (another preset, a manual toggle) wins over this match.
    const gen = ++generation.current
    loader
      .match(preset.pathGlobs)
      .then((roots) => {
        if (generation.current === gen)
          setSelected(new Map(roots.map((r) => [r.path, r.fileCount])))
      })
      .catch(() => {
        /* the index went away (closed, host gone): keep the selection */
      })
  }, [selectedPresetId, presets, loader, ready])

  // An expanded folder with nothing loaded (just expanded, or the index was
  // reopened after it expired) loads its first page.
  useEffect(() => {
    if (!loader || !ready) return
    for (const dir of expanded) if (!snapshot.dirs.has(dir)) void loader.loadMore(dir)
  }, [expanded, snapshot, loader, ready])

  const selection = useMemo(() => indexSelection(selected), [selected])

  const toggle = (entry: IgnoredEntry): void => {
    if (!loader) return
    const state = stateOf(selection, entry)
    const gen = ++generation.current
    setSelectedPresetId('custom')
    const holder = state === 'checked' ? ancestorRootOf(selected, entry.path) : null
    const apply = () =>
      setSelected((prev) => toggleSelection(prev, entry, state, (dir) => loader.childrenOf(dir)))
    if (holder === null || holder === entry.path) {
      apply()
      return
    }
    // Unchecking inside a selected folder keeps every sibling along the way: load
    // those folders completely first.
    Promise.all(chainDirs(holder, entry.path).map((dir) => loader.loadAll(dir)))
      .then(() => {
        if (generation.current === gen) apply()
      })
      .catch(() => {
        /* a folder could not load: the selection stays as it was */
      })
  }

  const allTopSelected =
    !!root &&
    root.items.length > 0 &&
    root.nextCursor === null &&
    root.items.every((n) => stateOf(selection, n) === 'checked')

  const toggleAll = (): void => {
    const gen = ++generation.current
    setSelectedPresetId('custom')
    if (allTopSelected || !loader) {
      setSelected(NO_SELECTION)
      return
    }
    loader
      .loadAll('')
      .then((items) => {
        if (generation.current === gen)
          setSelected(new Map(items.map((e) => [e.path, e.fileCount])))
      })
      .catch(() => {
        /* the root could not load completely: keep the selection */
      })
  }

  const toggleExpand = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const loadMore = (dir: string): void => {
    void loader?.loadMore(dir)
  }

  const selectedFileCount = selection.total

  const handleConfirm = () => {
    if (selectedFileCount === 0) {
      onConfirm({ mode: 'none' })
    } else {
      onConfirm({ mode: 'custom', paths: [...selected.keys()] })
    }
  }

  const handleSkip = () => {
    onConfirm({ mode: 'none' })
  }

  const tree: TreeProps = {
    dirs: snapshot.dirs,
    selection,
    expanded,
    onToggle: toggle,
    onToggleExpand: toggleExpand,
    onLoadMore: loadMore
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-lg flex flex-col">
        <DialogHeader className="space-y-1">
          <DialogTitle>Copy files to worktree</DialogTitle>
          <DialogDescription>
            Select which ignored files to include in the new worktree.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Preset</label>
            <Select value={selectedPresetId} onValueChange={setSelectedPresetId}>
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
                {selectedPresetId === 'custom' && <SelectItem value="custom">Custom</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 rounded-lg border bg-muted/20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Scanning ignored files…</span>
            </div>
          ) : !ready || snapshot.totalFiles === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No ignored files found.
            </p>
          ) : (
            <div className="flex flex-col gap-2 min-h-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {selectedFileCount} file{selectedFileCount !== 1 ? 's' : ''} selected
                </span>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {allTopSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border py-1 max-h-[40vh]">
                {root?.items.map((node) => (
                  <NodeRow key={node.path} node={node} depth={0} {...tree} />
                ))}
                {root && root.nextCursor !== null && (
                  <DirFooter dir="" state={root} depth={-1} onLoadMore={loadMore} />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handleSkip}>
            Skip
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={selectedFileCount === 0}>
            Copy {selectedFileCount} file{selectedFileCount !== 1 ? 's' : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
