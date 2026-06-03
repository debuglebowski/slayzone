import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, Button, Input, Label } from '@slayzone/ui'
import type { ProjectGroup } from '@slayzone/projects/shared'

interface GroupSettingsDialogProps {
  group: ProjectGroup
  open: boolean
  onClose: () => void
  onRename: (name: string) => void
  onDelete: () => void
}

/**
 * Settings modal for a project group (folder) — used by both sidebar views.
 * Electron has no `window.prompt`, and inline rename fights the tree's focus
 * steal, so a focus-trapped dialog is the reliable way to rename / delete.
 */
export function GroupSettingsDialog({
  group,
  open,
  onClose,
  onRename,
  onDelete
}: GroupSettingsDialogProps) {
  const [name, setName] = useState(group.name)
  // Reset the field whenever a different group is opened.
  useEffect(() => {
    setName(group.name)
  }, [group.id, group.name])

  const save = (): void => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== group.name) onRename(trimmed)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Folder settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="group-name">Name</Label>
          <Input
            id="group-name"
            value={name}
            autoFocus
            placeholder="Folder name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </div>
        <div className="mt-4 flex items-center justify-between">
          <Button
            variant="destructive"
            onClick={() => {
              onDelete()
              onClose()
            }}
          >
            Delete folder
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
