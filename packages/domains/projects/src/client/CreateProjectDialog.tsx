import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: Project) => void
}

const DEFAULT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']

export function CreateProjectDialog({ open, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(() => DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)])
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)

  const handleBrowse = async () => {
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Project Directory',
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths[0]) {
      const selectedPath = result.filePaths[0]
      setPath(selectedPath)
      // Auto-fill name from folder name if empty
      if (!name.trim()) {
        const folderName = selectedPath.split('/').pop() || ''
        setName(folderName)
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setLoading(true)
    try {
      const normalizedPath = path.trim()
      const project = await window.api.db.createProject({
        name: name.trim(),
        color,
        path: normalizedPath || undefined
      })
      onCreated(project)
      setName('')
      setPath('')
      setColor(DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)])
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="path">Repository Path</Label>
            <div className="flex gap-2">
              <Input
                id="path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/repo"
                className="flex-1"
              />
              <IconButton type="button" variant="outline" aria-label="Browse folder" onClick={handleBrowse}>
                <FolderOpen className="h-4 w-4" />
              </IconButton>
            </div>
            <p className="text-xs text-muted-foreground">
              Optional, used as terminal working directory and repository integrations source.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Color</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || loading}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
