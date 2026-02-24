import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import type { Project, ProjectTaskStorage } from '@slayzone/projects/shared'

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
  const [taskStorage, setTaskStorage] = useState<ProjectTaskStorage>('database')
  const [loading, setLoading] = useState(false)

  const handleBrowse = async () => {
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Project Directory',
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths[0]) {
      setPath(result.filePaths[0])
      // Auto-fill name from folder name if empty
      if (!name.trim()) {
        const folderName = result.filePaths[0].split('/').pop() || ''
        setName(folderName)
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setLoading(true)
    try {
      const project = await window.api.db.createProject({
        name: name.trim(),
        color,
        path: path || undefined,
        taskStorage
      })
      if (taskStorage === 'repository' && path) {
        await window.api.db.syncTasksFromProject(project.id)
        const refreshData = (window as { __slayzone_refreshData?: () => void }).__slayzone_refreshData
        refreshData?.()
      }
      onCreated(project)
      setName('')
      setPath('')
      setTaskStorage('database')
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
              <Button type="button" variant="outline" size="icon" onClick={handleBrowse}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Claude Code terminal will open in this directory
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-storage">Task Storage</Label>
            <Select value={taskStorage} onValueChange={(value) => setTaskStorage(value as ProjectTaskStorage)}>
              <SelectTrigger id="task-storage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="database">Database (SQLite)</SelectItem>
                <SelectItem value="repository">Repository (`docs/tasks/*.json`)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Repository mode reads and writes task files in <code>docs/tasks</code>.
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
            <Button
              type="submit"
              disabled={!name.trim() || loading || (taskStorage === 'repository' && !path.trim())}
            >
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
