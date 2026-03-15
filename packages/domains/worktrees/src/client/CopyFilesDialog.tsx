import { useState, useEffect, useCallback } from 'react'
import { Loader2, Folder, File, ChevronRight, Files, ListChecks, FolderX } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  Button, Checkbox
} from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'
import type { IgnoredFileNode } from '../shared/types'

export type CopyChoice =
  | { mode: 'all' }
  | { mode: 'custom'; paths: string[] }
  | { mode: 'none' }

type CardMode = CopyChoice['mode']

interface CopyFilesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoPath: string
  onConfirm: (choice: CopyChoice, remember: boolean) => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const val = bytes / Math.pow(1024, i)
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`
}

function TreeRow({ node, depth, expanded, onToggleExpand }: {
  node: IgnoredFileNode
  depth: number
  expanded: Set<string>
  onToggleExpand: (path: string) => void
}) {
  const isExpanded = expanded.has(node.path)

  return (
    <>
      <div
        className="flex items-center gap-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {node.isDirectory ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.path)}
            className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
          >
            <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            <span className="truncate">{node.name}/</span>
            <span className="ml-auto shrink-0 text-[10px] opacity-70">
              {node.fileCount.toLocaleString()} file{node.fileCount !== 1 ? 's' : ''}
            </span>
          </button>
        ) : (
          <span className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="w-3" />
            <File className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{node.name}</span>
            {node.size > 0 && (
              <span className="ml-auto shrink-0 text-[10px] opacity-70">{formatBytes(node.size)}</span>
            )}
          </span>
        )}
      </div>
      {isExpanded && node.children.map(child => (
        <TreeRow key={child.path} node={child} depth={depth + 1} expanded={expanded} onToggleExpand={onToggleExpand} />
      ))}
    </>
  )
}

const MODE_CARDS: { mode: CardMode; icon: typeof Files; label: string }[] = [
  { mode: 'all', icon: Files, label: 'Copy all files' },
  { mode: 'custom', icon: ListChecks, label: 'Select files to copy' },
  { mode: 'none', icon: FolderX, label: 'Copy no files' },
]

export function CopyFilesDialog({ open, onOpenChange, repoPath, onConfirm }: CopyFilesDialogProps) {
  const [mode, setMode] = useState<CardMode>('all')
  const [tree, setTree] = useState<IgnoredFileNode[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [remember, setRemember] = useState(false)
  const [loading, setLoading] = useState(false)
  const [treeLoaded, setTreeLoaded] = useState(false)

  const topLevelNames = tree.map(n => n.name)

  useEffect(() => {
    if (!open) return
    setMode('all')
    setRemember(false)
    setExpanded(new Set())
    setTree([])
    setTreeLoaded(false)
  }, [open])

  const loadTree = useCallback(() => {
    if (treeLoaded) return
    setLoading(true)
    window.api.git.getIgnoredFileTree(repoPath).then(nodes => {
      setTree(nodes)
      const preSelected = new Set<string>()
      for (const node of nodes) preSelected.add(node.name)
      setSelected(preSelected)
      setTreeLoaded(true)
      setLoading(false)
    })
  }, [repoPath, treeLoaded])

  useEffect(() => {
    if (mode === 'custom') loadTree()
  }, [mode, loadTree])

  const toggle = useCallback((name: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const toggleAll = () => {
    if (selected.size === topLevelNames.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(topLevelNames))
    }
  }

  const toggleExpand = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleCreate = () => {
    const choice: CopyChoice = mode === 'custom'
      ? { mode: 'custom', paths: [...selected] }
      : { mode }
    track('worktree_files_copied')
    onConfirm(choice, remember)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-lg flex flex-col">
        <DialogHeader className="space-y-1">
          <DialogTitle>Create new worktree</DialogTitle>
          <DialogDescription>
            What ignored files should be included?
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2">
          {MODE_CARDS.map(({ mode: m, icon: Icon, label }) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'flex flex-col items-center gap-3 rounded-lg border px-3 py-6 transition-colors',
                mode === m
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted'
              )}
            >
              <Icon className="h-9 w-9" />
              <span className="text-sm font-medium whitespace-nowrap">{label}</span>
            </button>
          ))}
        </div>

        {mode === 'custom' && (
          <>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : tree.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No ignored files found.</p>
            ) : (
              <div className="flex flex-col gap-3 min-h-0 flex-1">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {selected.size === topLevelNames.length ? 'Deselect all' : 'Select all'}
                </button>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border p-2">
                  {tree.map(node => (
                    <div key={node.name}>
                      <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted transition-colors">
                        <Checkbox
                          checked={selected.has(node.name)}
                          onCheckedChange={() => toggle(node.name)}
                        />
                        {node.isDirectory ? (
                          <button
                            type="button"
                            onClick={() => toggleExpand(node.path)}
                            className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                          >
                            <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform ${expanded.has(node.path) ? 'rotate-90' : ''}`} />
                            <Folder className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                            <span className="text-sm font-mono flex-1 truncate">{node.name}/</span>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {node.fileCount.toLocaleString()} file{node.fileCount !== 1 ? 's' : ''}
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
                      {expanded.has(node.path) && node.children.map(child => (
                        <TreeRow key={child.path} node={child} depth={1} expanded={expanded} onToggleExpand={toggleExpand} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <div className="flex items-center justify-between pt-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
            Remember for project
          </label>
          <Button
            onClick={handleCreate}
            disabled={mode === 'custom' && selected.size === 0}
          >
            Create worktree
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
