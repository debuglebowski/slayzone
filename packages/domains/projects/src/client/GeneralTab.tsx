import { useState, useEffect } from 'react'
import { FolderOpen, Upload } from 'lucide-react'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import { SettingsTabIntro } from './project-settings-shared'

interface GeneralTabProps {
  project: Project
  onUpdated: (project: Project) => void
  /** In-place update (e.g. icon upload) — does not close the dialog. */
  onChanged: (project: Project) => void
  onClose: () => void
}

export function GeneralTab({ project, onUpdated, onChanged, onClose }: GeneralTabProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('')
  const [path, setPath] = useState('')
  const [iconLetters, setIconLetters] = useState('')
  const [iconImagePath, setIconImagePath] = useState<string | null>(null)
  const [iconCacheKey, setIconCacheKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [iconBusy, setIconBusy] = useState(false)

  useEffect(() => {
    setName(project.name)
    setColor(project.color)
    setPath(project.path || '')
    setIconLetters(project.icon_letters || '')
    setIconImagePath(project.icon_image_path)
    setIconCacheKey(project.updated_at)
  }, [project])

  const fallbackLetters = (name || project.name).slice(0, 2).toUpperCase()
  const lettersPreview = iconLetters.trim().toUpperCase() || fallbackLetters

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

  const handleUploadIcon = async () => {
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Project Icon',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
    })
    if (result.canceled || !result.filePaths[0]) return
    setIconBusy(true)
    try {
      const updated = await window.api.db.uploadProjectIcon(project.id, result.filePaths[0])
      setIconImagePath(updated.icon_image_path)
      setIconCacheKey(updated.updated_at)
      onChanged(updated)
    } finally {
      setIconBusy(false)
    }
  }

  const handleRemoveIcon = async () => {
    setIconBusy(true)
    try {
      const updated = await window.api.db.updateProject({ id: project.id, iconImagePath: null })
      setIconImagePath(null)
      setIconCacheKey(updated.updated_at)
      onChanged(updated)
    } finally {
      setIconBusy(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setLoading(true)
    try {
      const trimmedLetters = iconLetters.trim()
      const updated = await window.api.db.updateProject({
        id: project.id,
        name: name.trim(),
        color,
        path: path || null,
        iconLetters: trimmedLetters.length > 0 ? trimmedLetters : null
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
        <div className="space-y-2">
          <Label>Icon</Label>
          <div className="flex items-center gap-3">
            <div
              className="h-14 w-14 rounded-md flex items-center justify-center overflow-hidden font-semibold text-white shrink-0"
              style={{ backgroundColor: color }}
            >
              {iconImagePath ? (
                <img
                  src={`slz-file://${iconImagePath}?v=${encodeURIComponent(iconCacheKey)}`}
                  alt=""
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className={lettersPreview.length >= 5 ? 'text-xs' : lettersPreview.length > 2 ? 'text-sm' : 'text-base'}>{lettersPreview}</span>
              )}
            </div>
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                {!iconImagePath && (
                  <Input
                    id="edit-icon-letters"
                    value={iconLetters}
                    maxLength={5}
                    placeholder={fallbackLetters}
                    onChange={(e) => setIconLetters(e.target.value)}
                    className="w-28"
                  />
                )}
                <Button type="button" variant="outline" size="sm" onClick={handleUploadIcon} disabled={iconBusy}>
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  {iconImagePath ? 'Upload new image' : 'Upload image'}
                </Button>
                {iconImagePath && (
                  <button
                    type="button"
                    onClick={handleRemoveIcon}
                    disabled={iconBusy}
                    className="text-xs text-destructive hover:underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {iconImagePath
                  ? 'Remove the image to use initials instead.'
                  : 'Initials 1–5 chars (empty = derive from name). Upload an image to override.'}
              </p>
            </div>
          </div>
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
