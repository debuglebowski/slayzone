import { useState, useEffect } from 'react'
import { Button, Input, Label } from '@slayzone/ui'
import type { Tag } from '@slayzone/tags/shared'
import { SettingsTabIntro } from './SettingsTabIntro'

export function TagsSettingsTab() {
  const [tags, setTags] = useState<Tag[]>([])
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#6b7280')
  const [editingTag, setEditingTag] = useState<Tag | null>(null)

  useEffect(() => {
    window.api.tags.getTags().then(setTags)
  }, [])

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return
    const tag = await window.api.tags.createTag({
      name: newTagName.trim(),
      color: newTagColor
    })
    setTags([...tags, tag])
    setNewTagName('')
    setNewTagColor('#6b7280')
  }

  const handleUpdateTag = async () => {
    if (!editingTag || !editingTag.name.trim()) return
    const updated = await window.api.tags.updateTag({
      id: editingTag.id,
      name: editingTag.name.trim(),
      color: editingTag.color
    })
    setTags(tags.map((t) => (t.id === updated.id ? updated : t)))
    setEditingTag(null)
  }

  const handleDeleteTag = async (id: string) => {
    await window.api.tags.deleteTag(id)
    setTags(tags.filter((t) => t.id !== id))
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Tags"
        description="Create and maintain reusable labels for tasks. Tags help organize work, improve filtering, and keep status views easy to scan."
      />
      <div className="space-y-3">
        <Label className="text-base font-semibold">Tags</Label>
        <div className="space-y-2">
          {tags.map((tag) => (
            <div key={tag.id} className="flex items-center gap-2">
              {editingTag?.id === tag.id ? (
                <>
                  <div
                    className="size-4 rounded-full shrink-0"
                    style={{ backgroundColor: editingTag.color }}
                  />
                  <Input
                    value={editingTag.name}
                    onChange={(e) => setEditingTag({ ...editingTag, name: e.target.value })}
                    className="flex-1 h-8"
                  />
                  <Button size="sm" variant="ghost" onClick={handleUpdateTag}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingTag(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <div
                    className="size-4 rounded-full shrink-0"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="flex-1">{tag.name}</span>
                  <Button size="sm" variant="ghost" onClick={() => setEditingTag({ ...tag })}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => handleDeleteTag(tag.id)}
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="new-tag" className="text-xs">New tag</Label>
            <Input
              id="new-tag"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="Tag name"
              onKeyDown={(e) => e.key === 'Enter' && handleCreateTag()}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Color</Label>
            <Input
              type="color"
              value={newTagColor}
              onChange={(e) => setNewTagColor(e.target.value)}
              className="w-12 h-9 p-1 cursor-pointer"
            />
          </div>
          <Button onClick={handleCreateTag} disabled={!newTagName.trim()}>
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}
