import { useState, useEffect } from 'react'
import type { Tag } from '@slayzone/tags/shared'
import { TAG_PRESETS } from '@slayzone/tags/shared'
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
  /** Existing tags — their colors will be dimmed in the picker */
  existingTags?: Tag[]
  onCreated: (tag: Tag) => void
  onUpdated?: (tag: Tag) => void
}

const DEFAULT_PRESET = TAG_PRESETS[17] // indigo

export function CreateTagDialog({ open, onOpenChange, projectId, tag, existingTags, onCreated, onUpdated }: CreateTagDialogProps) {
  const usedColors = new Set(
    (existingTags ?? [])
      .filter((t) => !tag || t.id !== tag.id) // don't exclude the tag being edited
      .map((t) => `${t.color}:${t.text_color}`)
  )
  const isEditing = !!tag
  const [name, setName] = useState('')
  const [selected, setSelected] = useState(DEFAULT_PRESET)

  useEffect(() => {
    if (open) {
      setName(tag?.name ?? '')
      if (tag) {
        const match = TAG_PRESETS.find((p) => p.bg === tag.color && p.text === tag.text_color)
        setSelected(match ?? { bg: tag.color, text: tag.text_color })
      } else {
        setSelected(DEFAULT_PRESET)
      }
    }
  }, [open, tag])

  const handleSubmit = async () => {
    if (!name.trim()) return
    if (isEditing) {
      const updated = await window.api.tags.updateTag({
        id: tag.id,
        name: name.trim(),
        color: selected.bg,
        textColor: selected.text
      })
      onUpdated?.(updated)
      window.dispatchEvent(new CustomEvent('slayzone:tag-updated', { detail: updated }))
    } else {
      if (!projectId) return
      const created = await window.api.tags.createTag({
        name: name.trim(),
        color: selected.bg,
        textColor: selected.text,
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
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tag name"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="grid grid-cols-10 gap-1.5">
              {TAG_PRESETS.filter((preset) => !usedColors.has(`${preset.bg}:${preset.text}`)).map((preset, i) => (
                <button
                  key={i}
                  type="button"
                  className="size-6 rounded-full border-2 transition-transform hover:scale-110 flex items-center justify-center text-[8px] font-bold"
                  style={{
                    backgroundColor: preset.bg,
                    color: preset.text,
                    borderColor: selected.bg === preset.bg && selected.text === preset.text ? 'currentColor' : 'transparent',
                    outline: selected.bg === preset.bg && selected.text === preset.text ? `2px solid ${preset.bg}` : 'none',
                    outlineOffset: '1px'
                  }}
                  onClick={() => setSelected(preset)}
                >
                  A
                </button>
              ))}
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
