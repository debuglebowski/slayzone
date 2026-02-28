import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import type { WorktreeCopyEntry } from '../shared/types'
import { copyEntriesKey, legacyCopyEntriesKey, parseCopyEntries } from '../shared/copy-entry-schema'

interface CreateWorktreeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  projectId: string
  /** When set, new worktrees branch from this; when empty, use current branch. */
  worktreeSourceBranch?: string | null
  onCreated: (worktreePath: string, parentBranch: string | null) => void
}

export function CreateWorktreeDialog({
  open,
  onOpenChange,
  projectPath,
  projectId,
  worktreeSourceBranch,
  onCreated
}: CreateWorktreeDialogProps) {
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleBrowse = async () => {
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Worktree Directory',
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths[0]) {
      setPath(result.filePaths[0])
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!path.trim()) return

    setLoading(true)
    setError(null)

    try {
      const currentBranch = await window.api.git.getCurrentBranch(projectPath)
      const sourceBranch = worktreeSourceBranch?.trim() || currentBranch

      let copyEntries: WorktreeCopyEntry[] | undefined
      try {
        let raw = await window.api.settings.get(copyEntriesKey(projectId))
        if (!raw) {
          const legacyRaw = await window.api.settings.get(legacyCopyEntriesKey(projectPath))
          if (legacyRaw) {
            window.api.settings.set(copyEntriesKey(projectId), legacyRaw)
            raw = legacyRaw
          } else {
            raw = await window.api.settings.get('worktree_copy_files')
          }
        }
        const { entries } = parseCopyEntries(raw)
        copyEntries = entries.length > 0 ? entries : undefined
      } catch { /* ignore */ }

      // Create git worktree
      await window.api.git.createWorktree(projectPath, path, branch || undefined, copyEntries, sourceBranch || undefined)
      onCreated(path.trim(), sourceBranch)
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create worktree')
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setPath('')
    setBranch('')
    setError(null)
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) resetForm()
    onOpenChange(open)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Worktree</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wt-path">Path</Label>
            <div className="flex gap-2">
              <Input
                id="wt-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/worktree"
                className="flex-1"
                autoFocus
              />
              <Button type="button" variant="outline" size="icon" onClick={handleBrowse}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Directory where the worktree will be created
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wt-branch">Branch (optional)</Label>
            <Input
              id="wt-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="feature/my-branch"
            />
            <p className="text-xs text-muted-foreground">
              Creates new branch if specified, otherwise uses detached HEAD
            </p>
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!path.trim() || loading}>
              {loading ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
