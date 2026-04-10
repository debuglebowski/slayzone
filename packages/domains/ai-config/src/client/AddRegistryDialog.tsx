import { useState } from 'react'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@slayzone/ui'

interface AddRegistryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (githubUrl: string, branch?: string, path?: string) => Promise<void>
}

export function AddRegistryDialog({ open, onOpenChange, onAdd }: AddRegistryDialogProps) {
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [skillsPath, setSkillsPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!url.trim()) return
    setLoading(true)
    setError(null)
    try {
      await onAdd(
        url.trim(),
        branch.trim() || undefined,
        skillsPath.trim() || undefined
      )
      setUrl('')
      setBranch('')
      setSkillsPath('')
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add registry')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Skill Registry</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>GitHub Repository</Label>
            <Input
              placeholder="owner/repo or https://github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            />
            <p className="text-[11px] text-muted-foreground">
              Public GitHub repo containing skills in SKILL.md format
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Branch</Label>
              <Input
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Skills path</Label>
              <Input
                placeholder="skills"
                value={skillsPath}
                onChange={(e) => setSkillsPath(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!url.trim() || loading}>
            {loading ? 'Adding...' : 'Add Registry'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
