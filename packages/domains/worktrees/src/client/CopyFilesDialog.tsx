import { useState, useEffect, useCallback, useMemo } from 'react'
import { Loader2, Folder, File, ChevronRight } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  Button, Checkbox,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import type { IgnoredFileNode, WorktreeCopyPreset } from '../shared/types'
import { DEFAULT_COPY_PRESETS } from '../shared/types'

export type CopyChoice =
  | { mode: 'none' }
  | { mode: 'custom'; paths: string[] }

interface CopyFilesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoPath: string
  onConfirm: (choice: CopyChoice) => void
}

type NodeState = 'checked' | 'indeterminate' | 'unchecked'

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function filterTreeByGlobs(nodes: IgnoredFileNode[], globs: string[]): Set<string> {
  if (globs.length === 0) return new Set(nodes.map(n => n.path))

  // Single-segment globs (e.g. ".env*") match a file's basename at any depth.
  // Multi-segment globs (e.g. "docs/**") match the top-level dir by first segment.
  const basenameMatchers: RegExp[] = []
  const dirPrefixes: string[] = []
  for (const glob of globs) {
    const firstSlash = glob.indexOf('/')
    if (firstSlash === -1) {
      basenameMatchers.push(globToRegex(glob))
    } else {
      dirPrefixes.push(glob.slice(0, firstSlash))
    }
  }

  const matched = new Set<string>()

  for (const node of nodes) {
    if (node.isDirectory && dirPrefixes.includes(node.name)) {
      matched.add(node.path)
    }
  }

  const walk = (node: IgnoredFileNode) => {
    if (!node.isDirectory && basenameMatchers.some(re => re.test(node.name))) {
      matched.add(node.path)
    }
    for (const child of node.children) walk(child)
  }
  for (const node of nodes) walk(node)

  return matched
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const val = bytes / Math.pow(1024, i)
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`
}

/**
 * Compute per-node checkbox state + the total number of files covered.
 * Selection model: `selected` is a set of "selection roots" — either a file path
 * or a dir path meaning the whole subtree is copied. Invariant: no ancestor and
 * descendant appear together.
 */
function computeStates(tree: IgnoredFileNode[], selected: Set<string>): {
  states: Map<string, NodeState>
  selectedCounts: Map<string, number>
  selectedFileCount: number
} {
  const states = new Map<string, NodeState>()
  const selectedCounts = new Map<string, number>()
  let selectedFileCount = 0

  const walk = (node: IgnoredFileNode, ancestorSelected: boolean): { state: NodeState; count: number } => {
    const inherited = ancestorSelected || selected.has(node.path)
    if (!node.isDirectory) {
      const st: NodeState = inherited ? 'checked' : 'unchecked'
      states.set(node.path, st)
      const count = inherited ? 1 : 0
      selectedCounts.set(node.path, count)
      if (inherited) selectedFileCount += 1
      return { state: st, count }
    }
    let total = 0
    let anyChecked = false
    let anyUnchecked = false
    let anyIndeterminate = false
    for (const c of node.children) {
      const r = walk(c, inherited)
      total += r.count
      if (r.state === 'checked') anyChecked = true
      else if (r.state === 'unchecked') anyUnchecked = true
      else anyIndeterminate = true
    }
    let st: NodeState
    if (inherited) st = 'checked'
    else if (anyIndeterminate || (anyChecked && anyUnchecked)) st = 'indeterminate'
    else if (anyChecked) st = 'checked'
    else st = 'unchecked'
    states.set(node.path, st)
    selectedCounts.set(node.path, total)
    return { state: st, count: total }
  }

  for (const n of tree) walk(n, false)
  return { states, selectedCounts, selectedFileCount }
}

/** Return chain of nodes from top-level ancestor down to the target (inclusive). */
function findChain(tree: IgnoredFileNode[], targetPath: string): IgnoredFileNode[] | null {
  for (const node of tree) {
    if (node.path === targetPath) return [node]
    if (targetPath.startsWith(node.path + '/')) {
      const sub = findChain(node.children, targetPath)
      if (sub) return [node, ...sub]
    }
  }
  return null
}

function removeSubtree(node: IgnoredFileNode, set: Set<string>): void {
  set.delete(node.path)
  for (const c of node.children) removeSubtree(c, set)
}

function NodeRow({
  node, depth, states, selectedCounts, expanded, onToggle, onToggleExpand,
}: {
  node: IgnoredFileNode
  depth: number
  states: Map<string, NodeState>
  selectedCounts: Map<string, number>
  expanded: Set<string>
  onToggle: (path: string) => void
  onToggleExpand: (path: string) => void
}) {
  const state = states.get(node.path) ?? 'unchecked'
  const isExpanded = expanded.has(node.path)
  const checked: boolean | 'indeterminate' =
    state === 'checked' ? true : state === 'indeterminate' ? 'indeterminate' : false
  const selectedCount = selectedCounts.get(node.path) ?? 0

  return (
    <>
      <div
        className="flex items-center gap-2 py-1 rounded hover:bg-muted transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: 8 }}
      >
        <Checkbox checked={checked} onCheckedChange={() => onToggle(node.path)} />
        {node.isDirectory ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.path)}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform', isExpanded && 'rotate-90')} />
            <Folder className="h-3.5 w-3.5 text-blue-400 shrink-0" />
            <span className="text-sm font-mono flex-1 truncate">{node.name}/</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {node.fileCount} file{node.fileCount !== 1 ? 's' : ''}
              {selectedCount > 0 && (
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
              <span className="text-xs text-muted-foreground shrink-0">{formatBytes(node.size)}</span>
            )}
          </span>
        )}
      </div>
      {node.isDirectory && isExpanded && node.children.map(child => (
        <NodeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          states={states}
          selectedCounts={selectedCounts}
          expanded={expanded}
          onToggle={onToggle}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </>
  )
}

export function CopyFilesDialog({ open, onOpenChange, repoPath, onConfirm }: CopyFilesDialogProps) {
  const [presets, setPresets] = useState<WorktreeCopyPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState<string>('')
  const [tree, setTree] = useState<IgnoredFileNode[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [treeLoaded, setTreeLoaded] = useState(false)

  useEffect(() => {
    if (!open) return
    setExpanded(new Set())
    setTree([])
    setTreeLoaded(false)

    window.api.settings.get('worktree_copy_presets').then((raw) => {
      const parsed = raw ? JSON.parse(raw) as WorktreeCopyPreset[] : null
      const list = parsed && parsed.length > 0 ? parsed : DEFAULT_COPY_PRESETS
      setPresets(list)
      setSelectedPresetId(list[0].id)
    }).catch(() => {
      setPresets(DEFAULT_COPY_PRESETS)
      setSelectedPresetId(DEFAULT_COPY_PRESETS[0].id)
    })

    setLoading(true)
    window.api.git.getIgnoredFileTree(repoPath).then(nodes => {
      setTree(nodes)
      setTreeLoaded(true)
      setLoading(false)
    }).catch(() => {
      setTree([])
      setTreeLoaded(true)
      setLoading(false)
    })
  }, [open, repoPath])

  useEffect(() => {
    if (!treeLoaded || presets.length === 0) return
    const preset = presets.find(p => p.id === selectedPresetId)
    if (!preset) return
    setSelected(filterTreeByGlobs(tree, preset.pathGlobs))
  }, [selectedPresetId, treeLoaded, tree, presets])

  const { states, selectedCounts, selectedFileCount } = useMemo(
    () => computeStates(tree, selected),
    [tree, selected]
  )

  const toggle = useCallback((path: string) => {
    setSelected(prev => {
      const state = computeStates(tree, prev).states.get(path) ?? 'unchecked'
      const chain = findChain(tree, path)
      if (!chain) return prev
      const leaf = chain[chain.length - 1]
      const next = new Set(prev)

      if (state === 'checked') {
        // Uncheck — if an ancestor holds the selection, expand it along the chain
        // so that siblings along the way stay selected but the target's subtree doesn't.
        let ancestorIdx = -1
        for (let i = 0; i < chain.length; i++) {
          if (next.has(chain[i].path)) { ancestorIdx = i; break }
        }
        if (ancestorIdx >= 0 && ancestorIdx < chain.length - 1) {
          next.delete(chain[ancestorIdx].path)
          for (let i = ancestorIdx; i < chain.length - 1; i++) {
            const cur = chain[i]
            const nextInPath = chain[i + 1]
            for (const child of cur.children) {
              if (child.path !== nextInPath.path) next.add(child.path)
            }
          }
        }
        removeSubtree(leaf, next)
      } else {
        // Check (from unchecked or indeterminate)
        removeSubtree(leaf, next)
        next.add(leaf.path)
      }

      return next
    })
    setSelectedPresetId('custom')
  }, [tree])

  const toggleAll = () => {
    const topLevel = tree.map(n => n.path)
    const allSelected = topLevel.every(p => selected.has(p))
    if (allSelected && selected.size === topLevel.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(topLevel))
    }
    setSelectedPresetId('custom')
  }

  const toggleExpand = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleConfirm = () => {
    if (selected.size === 0) {
      onConfirm({ mode: 'none' })
    } else {
      onConfirm({ mode: 'custom', paths: [...selected] })
    }
  }

  const handleSkip = () => {
    onConfirm({ mode: 'none' })
  }

  const allTopSelected = tree.length > 0 && tree.every(n => (states.get(n.path) ?? 'unchecked') === 'checked')

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
                {presets.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
                {selectedPresetId === 'custom' && (
                  <SelectItem value="custom">Custom</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 rounded-lg border bg-muted/20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Scanning ignored files…</span>
            </div>
          ) : tree.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No ignored files found.</p>
          ) : (
            <div className="flex flex-col gap-2 min-h-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {selectedFileCount} file{selectedFileCount !== 1 ? 's' : ''} selected
                </span>
                <button type="button" onClick={toggleAll} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                  {allTopSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border py-1 max-h-[40vh]">
                {tree.map(node => (
                  <NodeRow
                    key={node.path}
                    node={node}
                    depth={0}
                    states={states}
                    selectedCounts={selectedCounts}
                    expanded={expanded}
                    onToggle={toggle}
                    onToggleExpand={toggleExpand}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handleSkip}>Skip</Button>
          <Button size="sm" onClick={handleConfirm} disabled={selectedFileCount === 0}>
            Copy {selectedFileCount} file{selectedFileCount !== 1 ? 's' : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
