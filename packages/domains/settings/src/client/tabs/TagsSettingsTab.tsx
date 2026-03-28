import { useState, useEffect } from 'react'
import { Button, Label } from '@slayzone/ui'
import type { Tag } from '@slayzone/tags/shared'
import { CreateTagDialog } from '@slayzone/tags/client'
import { SettingsTabIntro } from './SettingsTabIntro'
import { ChevronUp, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react'

interface TagsSettingsTabProps {
  projectId: string
}

export function TagsSettingsTab({ projectId }: TagsSettingsTabProps) {
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [dialogState, setDialogState] = useState<{ mode: 'create' } | { mode: 'edit'; tag: Tag } | null>(null)

  useEffect(() => {
    window.api.tags.getTags().then(setAllTags)
  }, [])

  const tags = allTags.filter((t) => t.project_id === projectId)


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
      <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-base font-semibold">Tags</Label>
            <Button size="sm" variant="outline" onClick={() => setDialogState({ mode: 'create' })}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New tag
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {tags.map((tag, i) => (
              <div
                key={tag.id}
                className="group rounded-lg border border-border p-3 flex items-center gap-3 hover:bg-muted/30 transition-colors"
              >
                <span
                  className="rounded-full px-3 py-1 text-sm font-medium shrink-0"
                  style={{ backgroundColor: tag.color, color: tag.text_color }}
                >
                  {tag.name}
                </span>
                <span className="flex-1" />
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="icon" variant="ghost" className="h-6 w-6" disabled={i === 0} onClick={() => handleMoveTag(i, -1)}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6" disabled={i === tags.length - 1} onClick={() => handleMoveTag(i, 1)}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setDialogState({ mode: 'edit', tag })}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => handleDeleteTag(tag.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
            {tags.length === 0 && (
              <p className="text-sm text-muted-foreground col-span-2">No tags yet. Create one to get started.</p>
            )}
          </div>
          <CreateTagDialog
            open={!!dialogState}
            onOpenChange={(open) => { if (!open) setDialogState(null) }}
            projectId={projectId}
            tag={dialogState?.mode === 'edit' ? dialogState.tag : null}
            existingTags={tags}
            onCreated={(tag) => {
              setAllTags((prev) => [...prev, tag])
              window.dispatchEvent(new CustomEvent('slayzone:tag-created', { detail: tag }))
            }}
            onUpdated={(updated) => {
              setAllTags((prev) => prev.map((t) => t.id === updated.id ? updated : t))
              window.dispatchEvent(new CustomEvent('slayzone:tag-updated', { detail: updated }))
            }}
          />
        </div>
    </div>
  )
}
