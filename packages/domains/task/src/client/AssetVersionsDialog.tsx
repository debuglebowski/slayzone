import { useMemo, useState } from 'react'
import { Check, FilePlus, Lock, Pencil, Eye } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  cn,
} from '@slayzone/ui'
import type { AssetVersion } from '@slayzone/task-assets/shared'

interface TreeNode {
  version: AssetVersion
  children: TreeNode[]
}

function buildForest(versions: AssetVersion[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const v of versions) byId.set(v.id, { version: v, children: [] })
  const roots: TreeNode[] = []
  for (const node of byId.values()) {
    const parentId = node.version.parent_id
    const parent = parentId ? byId.get(parentId) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const byNum = (a: TreeNode, b: TreeNode): number => a.version.version_num - b.version.version_num
  const sortRec = (n: TreeNode): void => {
    n.children.sort(byNum)
    n.children.forEach(sortRec)
  }
  roots.sort(byNum)
  roots.forEach(sortRec)
  return roots
}

function shortHash(h: string): string {
  return h.slice(0, 7)
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  versions: AssetVersion[]
  currentVersionId: string | null
  loading: boolean
  onSetCurrent: (versionRef: number) => Promise<void>
  onRename: (versionRef: number, newName: string | null) => Promise<void>
  onOpenPreview: (version: AssetVersion) => void
  onCreateVersion: () => Promise<void>
}

interface NodeChromeProps {
  version: AssetVersion
  isCurrent: boolean
  locked: boolean
  isBusy: boolean
  isRenaming: boolean
  renameValue: string
  setRenameValue: (v: string) => void
  commitRename: (v: AssetVersion) => void | Promise<void>
  cancelRename: () => void
  startRename: (v: AssetVersion) => void
  onSetCurrent: (v: AssetVersion) => void | Promise<void>
  onOpenPreview: (v: AssetVersion) => void
}

function RenameField({
  v,
  renameValue,
  setRenameValue,
  commitRename,
  cancelRename,
}: {
  v: AssetVersion
  renameValue: string
  setRenameValue: (v: string) => void
  commitRename: (v: AssetVersion) => void | Promise<void>
  cancelRename: () => void
}): React.JSX.Element {
  return (
    <Input
      autoFocus
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onBlur={() => void commitRename(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commitRename(v)
        else if (e.key === 'Escape') cancelRename()
      }}
      placeholder="name (empty to clear)"
      className="h-6 text-xs"
    />
  )
}

function VersionPill({
  version: v,
  isCurrent,
  locked,
  isBusy,
  isRenaming,
  renameValue,
  setRenameValue,
  commitRename,
  cancelRename,
  startRename,
  onSetCurrent,
  onOpenPreview,
}: NodeChromeProps): React.JSX.Element {
  return (
    <div className="group relative flex items-stretch min-w-[220px]">
      <div
        className={cn(
          'flex-1 flex flex-col gap-1 rounded-lg border px-3 py-2 shadow-sm',
          isCurrent
            ? 'border-primary bg-primary/10'
            : 'border-border bg-card hover:bg-muted/60',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono tabular-nums text-sm font-semibold">
            v{v.version_num}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {shortHash(v.content_hash)}
          </span>
          <span className="flex-1" />
          {locked && !isCurrent && (
            <Lock className="size-3 text-muted-foreground/60" aria-label="locked" />
          )}
          {isCurrent && (
            <span className="rounded bg-primary px-1.5 py-0.5 text-[9px] font-medium text-primary-foreground uppercase tracking-wide">
              current
            </span>
          )}
        </div>
        {isRenaming ? (
          <RenameField
            v={v}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            commitRename={commitRename}
            cancelRename={cancelRename}
          />
        ) : v.name ? (
          <div className="text-xs font-medium truncate">{v.name}</div>
        ) : null}
        <div className="text-[10px] text-muted-foreground/70 truncate">
          {v.author_type ?? 'user'} · {new Date(v.created_at).toLocaleString()}
        </div>
      </div>
      <div
        className={cn(
          'absolute left-full top-0 ml-2 flex flex-col gap-1 rounded-md border border-border bg-popover px-1.5 py-1.5 shadow-[0_3px_6px_rgba(0,0,0,0.25)] dark:shadow-[0_3px_6px_rgba(255,255,255,0.1)] transition-opacity z-10 min-w-[150px]',
          'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto',
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-7 justify-start px-2 text-xs"
          disabled={isCurrent || isBusy}
          onClick={() => void onSetCurrent(v)}
        >
          <Check className="size-3.5 mr-2" /> Set as current
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 justify-start px-2 text-xs"
          onClick={() => onOpenPreview(v)}
        >
          <Eye className="size-3.5 mr-2" /> Open
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 justify-start px-2 text-xs"
          onClick={() => startRename(v)}
        >
          <Pencil className="size-3.5 mr-2" /> Rename
        </Button>
      </div>
    </div>
  )
}

export function AssetVersionsDialog({
  open,
  onOpenChange,
  versions,
  currentVersionId,
  loading,
  onSetCurrent,
  onRename,
  onOpenPreview,
  onCreateVersion,
}: Props): React.JSX.Element {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const forest = useMemo(() => buildForest(versions), [versions])
  const hasChildrenById = useMemo(() => {
    const s = new Set<string>()
    for (const v of versions) if (v.parent_id) s.add(v.parent_id)
    return s
  }, [versions])

  const commitRename = async (v: AssetVersion): Promise<void> => {
    const next = renameValue.trim()
    const normalized = next.length === 0 ? null : next
    if (normalized === v.name) { setRenamingId(null); return }
    setBusyId(v.id)
    try {
      await onRename(v.version_num, normalized)
    } finally {
      setBusyId(null)
      setRenamingId(null)
    }
  }

  const handleSetCurrent = async (v: AssetVersion): Promise<void> => {
    setBusyId(v.id)
    try {
      await onSetCurrent(v.version_num)
    } finally {
      setBusyId(null)
    }
  }

  const startRename = (v: AssetVersion): void => {
    setRenameValue(v.name ?? '')
    setRenamingId(v.id)
  }

  // Renders a subtree as a vertical column: children stacked above, parent at
  // bottom, connected by lines. When a node has multiple children they are
  // laid out horizontally above the parent, each with its own vertical
  // connector + a shared horizontal bar.
  const renderSubtree = (node: TreeNode): React.ReactNode => {
    const v = node.version
    const isCurrent = v.id === currentVersionId
    const locked = v.name !== null || hasChildrenById.has(v.id)
    const isRenaming = renamingId === v.id
    const isBusy = busyId === v.id
    const hasChildren = node.children.length > 0
    const multipleChildren = node.children.length > 1

    return (
      <div key={v.id} className="flex flex-col items-center">
        {hasChildren && (
          <>
            <div className="flex items-end gap-6 relative">
              {node.children.map((child, idx) => {
                const isFirst = idx === 0
                const isLast = idx === node.children.length - 1
                return (
                  <div key={child.version.id} className="flex flex-col items-center relative">
                    {renderSubtree(child)}
                    {/* vertical drop from child subtree to horizontal bar (or direct to parent) */}
                    <div className="w-px h-3 bg-border" />
                    {multipleChildren && (
                      <div
                        className={cn(
                          'absolute bottom-0 h-px bg-border',
                          isFirst ? 'left-1/2 right-[-12px]' : isLast ? 'left-[-12px] right-1/2' : 'left-[-12px] right-[-12px]',
                        )}
                      />
                    )}
                  </div>
                )
              })}
            </div>
            {/* vertical connector from horizontal bar down to parent pill */}
            <div className="w-px h-3 bg-border" />
          </>
        )}
        <VersionPill
          version={v}
          isCurrent={isCurrent}
          locked={locked}
          isBusy={isBusy}
          isRenaming={isRenaming}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
          commitRename={commitRename}
          cancelRename={() => setRenamingId(null)}
          startRename={startRename}
          onSetCurrent={handleSetCurrent}
          onOpenPreview={onOpenPreview}
        />
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Versions</DialogTitle>
          <DialogDescription>
            Root at the bottom, newest branches above. Set any version as current — edits from the app then branch from it.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto border border-border rounded-md bg-background">
          {loading ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">Loading…</div>
          ) : forest.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">No versions yet.</div>
          ) : (
            <div className="flex justify-center gap-10 px-4 py-6">
              {forest.map((n) => renderSubtree(n))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onCreateVersion()}
            disabled={loading}
          >
            <FilePlus className="size-3 mr-2" />
            Create version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
