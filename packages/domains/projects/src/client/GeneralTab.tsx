import { useState, useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import { SettingsTabIntro } from './project-settings-shared'

interface GeneralTabProps {
  project: Project
  onUpdated: (project: Project) => void
  onClose: () => void
}

export function GeneralTab({ project, onUpdated, onClose }: GeneralTabProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('')
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setName(project.name)
    setColor(project.color)
    setPath(project.path || '')
  }, [project])

  const handleBrowse = async () => {
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Project Directory',
      defaultPath: path || undefined,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (!result.canceled && result.filePaths[0]) {
      setPath(result.filePaths[0])
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setLoading(true)
    try {
      const updated = await window.api.db.updateProject({
        id: project.id,
        name: name.trim(),
        color,
        path: path || null
      })

      onUpdated(updated)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full space-y-6">
      <SettingsTabIntro
        title="General"
        description="Configure the project identity and repository defaults."
      />
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-1">
          <Label htmlFor="edit-name">Name</Label>
          <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="edit-path">Repository Path</Label>
          <div className="flex gap-2">
            <Input
              id="edit-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/repo"
              className="flex-1"
            />
            <IconButton type="button" variant="outline" aria-label="Browse folder" onClick={handleBrowse}>
              <FolderOpen className="h-4 w-4" />
            </IconButton>
          </div>
          <p className="text-xs text-muted-foreground">Claude Code terminal will open in this directory</p>
        </div>
        <div className="space-y-1">
          <Label>Color</Label>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || loading}>
            Save
          </Button>
        </div>
      </form>
    </div>
  )
}
