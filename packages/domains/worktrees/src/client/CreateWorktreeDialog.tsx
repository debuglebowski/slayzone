import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
interface CreateWorktreeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  projectId?: string
  onCreated: (worktreePath: string, parentBranch: string | null) => void
}

export function CreateWorktreeDialog({
  open,
  onOpenChange,
  projectPath,
  projectId,
  onCreated
}: CreateWorktreeDialogProps) {
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleBrowse = async () => {
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Worktree Directory',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
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
      // Capture parent branch before creating worktree
      const parentBranch = await window.api.git.getCurrentBranch(projectPath)

      // Create git worktree
      await window.api.git.createWorktree({ repoPath: projectPath, targetPath: path, branch: branch || undefined, projectId })
      onCreated(path.trim(), parentBranch)
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
              <IconButton type="button" aria-label="Browse folder" variant="outline" onClick={handleBrowse}>
                <FolderOpen className="h-4 w-4" />
              </IconButton>
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
