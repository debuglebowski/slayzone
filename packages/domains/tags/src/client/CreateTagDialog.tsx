import { useState, useEffect } from 'react'
import type { Tag } from '@slayzone/tags/shared'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Button, Input, Label
} from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'

interface CreateTagDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** If provided, dialog edits this tag instead of creating a new one */
  tag?: Tag | null
  onCreated: (tag: Tag) => void
  onUpdated?: (tag: Tag) => void
}

export function CreateTagDialog({ open, onOpenChange, projectId, tag, onCreated, onUpdated }: CreateTagDialogProps) {
  const isEditing = !!tag
  const [name, setName] = useState('')
  const [color, setColor] = useState('#6366f1')

  useEffect(() => {
    if (open) {
      setName(tag?.name ?? '')
      setColor(tag?.color ?? '#6366f1')
    }
  }, [open, tag])

  const handleSubmit = async () => {
    if (!name.trim()) return
    if (isEditing) {
      const updated = await window.api.tags.updateTag({
        id: tag.id,
        name: name.trim(),
        color
      })
      onUpdated?.(updated)
      window.dispatchEvent(new CustomEvent('slayzone:tag-updated', { detail: updated }))
    } else {
      if (!projectId) return
      const created = await window.api.tags.createTag({
        name: name.trim(),
        color,
        projectId
      })
      track('tag_created')
      onCreated(created)
      window.dispatchEvent(new CustomEvent('slayzone:tag-created', { detail: created }))
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Tag' : 'New Tag'}</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">Name</Label>
            <div className="flex items-center gap-2">
              <Input
                id="tag-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Tag name"
                autoFocus
                className="flex-1"
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
              />
              <Input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-9 h-9 p-0.5 cursor-pointer shrink-0"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!name.trim()}>{isEditing ? 'Save' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
