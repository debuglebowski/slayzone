import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'

export type ProjectStartMode = 'scratch' | 'github' | 'linear'

export interface ProjectCreationContext {
  startMode: ProjectStartMode
}

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: Project, context: ProjectCreationContext) => void
}

const DEFAULT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']
const START_OPTIONS: Array<{
  mode: ProjectStartMode
  label: string
  description: string
}> = [
  {
    mode: 'scratch',
    label: 'Start from scratch',
    description: 'Create tasks manually and configure integrations later.'
  },
  {
    mode: 'github',
    label: 'Sync with GitHub Projects',
    description: 'Set up project-scoped sync from a GitHub Project board.'
  },
  {
    mode: 'linear',
    label: 'Sync with Linear',
    description: 'Set up project-scoped sync from a Linear team or project.'
  }
]

export function CreateProjectDialog({ open, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(() => DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)])
  const [path, setPath] = useState('')
  const [startMode, setStartMode] = useState<ProjectStartMode>('scratch')
  const [loading, setLoading] = useState(false)
  const integrationsEnabled = import.meta.env.DEV
  const visibleStartOptions = integrationsEnabled
    ? START_OPTIONS
    : START_OPTIONS.filter((option) => option.mode === 'scratch')

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
        path: path || undefined
      })
      onCreated(project, { startMode: integrationsEnabled ? startMode : 'scratch' })
      setName('')
      setPath('')
      setStartMode('scratch')
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
              Claude Code terminal will open in this directory
            </p>
          </div>
          <div className="space-y-2">
            <Label>Color</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <div className="space-y-2">
            <Label>How do you want to start this project?</Label>
            <div className="space-y-2">
              {visibleStartOptions.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => setStartMode(option.mode)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    startMode === option.mode
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/50'
                  )}
                >
                  <p className="text-sm font-medium">{option.label}</p>
                  <p className="text-xs text-muted-foreground">{option.description}</p>
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || loading}>
              {(!integrationsEnabled || startMode === 'scratch') ? 'Create' : 'Create and continue'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
