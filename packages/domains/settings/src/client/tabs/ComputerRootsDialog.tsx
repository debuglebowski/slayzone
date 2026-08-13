import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FolderOpen, Plus, X } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  toast
} from '@slayzone/ui'

/**
 * Edit one computer's filesystem path-jail.
 *
 * `allowedRoots` bounds every path that computer will read, write, or run a
 * command in. It matters more than it used to: the app's filesystem work —
 * browsing for a project directory, the editor tree, the project-path probe —
 * now executes on the computer that owns the workspace rather than on the hub, so
 * a directory outside these roots is one the UI genuinely cannot reach.
 *
 * It is not a permission boundary against the hub, which can already spawn
 * arbitrary commands on a computer. It is a guard against a mistaken path — a
 * stale project row pointing somewhere it should not, and the hub dutifully
 * removing a directory there. That is why widening it is an ordinary setting
 * rather than a privileged operation.
 *
 * Saving replaces the set wholesale. The computer canonicalizes what it accepts
 * and returns whatever it refused, which is surfaced verbatim: a saved list that
 * silently differs from the enforced one is the failure mode worth avoiding.
 */

/** A computer whose jail is being edited, with hub-bound thunks. */
export type RootsTarget = {
  id: string
  name: string
  /** Read the current jail from THIS computer's hub. */
  load: () => Promise<{ roots: string[]; home: string | null }>
  /** Write it back through the same hub. */
  save: (roots: string[]) => Promise<{
    roots: string[]
    rejected: { path: string; reason: string }[]
  }>
}

export function ComputerRootsDialog({
  target,
  onClose
}: {
  target: RootsTarget | null
  onClose: () => void
}) {
  const [edited, setEdited] = useState<string[] | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  /**
   * Re-read on every open rather than caching: another client (or the hub's own
   * widening when a computer connects) may have changed the jail since this dialog
   * last ran, and editing a stale list would silently revert their change.
   *
   * `gcTime: 0` is what makes "every open" true — the query is keyed by computer,
   * so without it a reopen would paint the previous answer first.
   */
  const query = useQuery({
    queryKey: ['computer-allowed-roots', target?.id],
    queryFn: () => target!.load(),
    enabled: !!target,
    gcTime: 0,
    staleTime: 0
  })

  // Local edits shadow the fetched list; null = untouched, show what we loaded.
  const roots = edited ?? query.data?.roots ?? []
  const loading = query.isPending && !!target
  const error = query.isError
    ? query.error instanceof Error
      ? query.error.message
      : String(query.error)
    : null

  const addDraft = (): void => {
    const value = draft.trim()
    if (!value || roots.includes(value)) return
    setEdited([...roots, value])
    setDraft('')
  }

  const save = async (): Promise<void> => {
    if (!target) return
    setSaving(true)
    try {
      const res = await target.save(roots)
      setEdited(res.roots)
      if (res.rejected.length > 0) {
        // Not a failure — the rest was applied. But naming the entries that did
        // not take is the whole reason the computer reports them.
        toast.warning(
          `Saved without ${res.rejected.length}: ${res.rejected
            .map((r) => `${r.path} (${r.reason})`)
            .join(', ')}`
        )
      } else {
        toast.success(`Updated ${target.name}`)
      }
      onClose()
    } catch (err) {
      toast.error(`Could not save: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" data-testid="computer-roots-dialog">
        <DialogHeader>
          <DialogTitle>Allowed folders — {target?.name}</DialogTitle>
          <DialogDescription>
            Directories this computer may read, write, and run commands in. Projects outside every
            entry cannot be browsed or opened on this computer.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-destructive text-xs" data-testid="computer-roots-error">
            Could not read this computer&apos;s folders: {error}
          </p>
        ) : (
          <div className="space-y-2">
            {loading ? (
              <p className="text-muted-foreground text-xs">Reading…</p>
            ) : roots.length === 0 ? (
              // Not cosmetic: a computer with no roots refuses every filesystem
              // call, so this is the explanation for an otherwise silent failure.
              <p className="text-muted-foreground text-xs" data-testid="computer-roots-empty">
                No folders configured — this computer refuses all filesystem access.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="computer-roots-list">
                {roots.map((root) => (
                  <li
                    key={root}
                    className="border-border bg-muted/30 flex items-center gap-2 rounded border px-2 py-1.5"
                  >
                    <FolderOpen className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={root}>
                      {root}
                    </span>
                    <IconButton
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${root}`}
                      onClick={() => setEdited(roots.filter((r) => r !== root))}
                    >
                      <X className="size-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}

            {/* Typed, not browsed: the picker can only show what is already
                inside the jail, so it cannot be the way to widen it. */}
            <div className="flex gap-2">
              <Input
                value={draft}
                placeholder="/absolute/path/on/the/computer"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addDraft()
                  }
                }}
                data-testid="computer-roots-input"
              />
              <Button variant="outline" onClick={addDraft} disabled={!draft.trim()}>
                <Plus className="mr-1 size-3.5" />
                Add
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || loading || !!error}
            data-testid="computer-roots-save"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
