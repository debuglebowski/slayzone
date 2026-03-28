import { useState, useEffect } from 'react'
import { Button, Input, Label } from '@slayzone/ui'
import type { Tag } from '@slayzone/tags/shared'
import { CreateTagDialog } from '@slayzone/tags/client'
import { useTabStore } from '../useTabStore'
import { SettingsTabIntro } from './SettingsTabIntro'
import { ChevronUp, ChevronDown, Plus } from 'lucide-react'

export function TagsSettingsTab() {
  const selectedProjectId = useTabStore((s) => s.selectedProjectId)
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [editingTag, setEditingTag] = useState<Tag | null>(null)
  const [createTagOpen, setCreateTagOpen] = useState(false)

  useEffect(() => {
    window.api.tags.getTags().then(setAllTags)
  }, [])

  const tags = selectedProjectId ? allTags.filter((t) => t.project_id === selectedProjectId) : allTags

  const handleUpdateTag = async () => {
    if (!editingTag || !editingTag.name.trim()) return
    const updated = await window.api.tags.updateTag({
      id: editingTag.id,
      name: editingTag.name.trim(),
      color: editingTag.color
    })
    setAllTags(allTags.map((t) => (t.id === updated.id ? updated : t)))
    setEditingTag(null)
  }

  const handleDeleteTag = async (id: string) => {
    await window.api.tags.deleteTag(id)
    setAllTags(allTags.filter((t) => t.id !== id))
  }

  const handleMoveTag = async (index: number, direction: -1 | 1) => {
    const swapIndex = index + direction
    if (swapIndex < 0 || swapIndex >= tags.length) return
    const reordered = [...tags]
    const tmp = reordered[index]
    reordered[index] = reordered[swapIndex]
    reordered[swapIndex] = tmp
    const reorderedIds = reordered.map((t) => t.id)
    await window.api.tags.reorderTags(reorderedIds)
    const updatedAll = allTags.map((t) => {
      const idx = reorderedIds.indexOf(t.id)
      return idx >= 0 ? { ...t, sort_order: idx } : t
    })
    setAllTags(updatedAll)
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Tags"
        description="Create and maintain reusable labels for tasks. Tags help organize work, improve filtering, and keep status views easy to scan."
      />
      {!selectedProjectId ? (
        <p className="text-sm text-muted-foreground">Select a project to manage its tags.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-base font-semibold">Tags</Label>
            <Button size="sm" variant="outline" onClick={() => setCreateTagOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New tag
            </Button>
          </div>
          <div className="space-y-2">
            {tags.map((tag, i) => (
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
                    <Input
                      type="color"
                      value={editingTag.color}
                      onChange={(e) => setEditingTag({ ...editingTag, color: e.target.value })}
                      className="w-10 h-8 p-0.5 cursor-pointer"
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
                    <div className="flex flex-col -space-y-1">
                      <Button size="icon" variant="ghost" className="h-4 w-4" disabled={i === 0} onClick={() => handleMoveTag(i, -1)}>
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-4 w-4" disabled={i === tags.length - 1} onClick={() => handleMoveTag(i, 1)}>
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                    </div>
                    <span
                      className="rounded px-2 py-1 text-sm font-medium"
                      style={{ backgroundColor: tag.color, color: tag.text_color }}
                    >
                      {tag.name}
                    </span>
                    <span className="flex-1" />
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
            {tags.length === 0 && (
              <p className="text-sm text-muted-foreground">No tags yet. Create one to get started.</p>
            )}
          </div>
          <CreateTagDialog
            open={createTagOpen}
            onOpenChange={setCreateTagOpen}
            projectId={selectedProjectId}
            existingTags={tags}
            onCreated={(tag) => {
              setAllTags((prev) => [...prev, tag])
            }}
          />
        </div>
      )}
    </div>
  )
}
