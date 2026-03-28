import { useState } from 'react'
import type { Tag } from '@slayzone/tags/shared'
import { Button, Checkbox } from '@slayzone/ui'
import { Pencil, Plus } from 'lucide-react'
import { CreateTagDialog } from './CreateTagDialog'

interface TagSelectorProps {
  tags: Tag[]
  selectedTagIds: string[]
  projectId: string
  onToggle: (tagId: string, checked: boolean) => void
  onTagCreated?: (tag: Tag) => void
}

export function TagSelector({ tags, selectedTagIds, projectId, onToggle, onTagCreated }: TagSelectorProps) {
  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const [editingTag, setEditingTag] = useState<Tag | null>(null)

  return (
    <>
      {tags.length > 0 && (
        <div className="space-y-0.5">
          {tags.map((tag) => (
            <label key={tag.id} className="group flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
              <Checkbox
                checked={selectedTagIds.includes(tag.id)}
                onCheckedChange={(checked) => onToggle(tag.id, checked === true)}
              />
              <span
                className="flex-1 rounded px-2 py-1 text-sm font-medium inline-flex items-center justify-between gap-1"
                style={{ backgroundColor: tag.color, color: tag.text_color }}
              >
                {tag.name}
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingTag(tag); setTagDialogOpen(true) }}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className={tags.length > 0 ? 'border-t mt-1.5 pt-1' : ''}>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground h-7 px-1.5"
          onClick={() => { setEditingTag(null); setTagDialogOpen(true) }}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New tag
        </Button>
      </div>
      <CreateTagDialog
        open={tagDialogOpen}
        onOpenChange={setTagDialogOpen}
        projectId={projectId}
        tag={editingTag}
        existingTags={tags}
        onCreated={(tag) => {
          onTagCreated?.(tag)
          onToggle(tag.id, true)
        }}
        onUpdated={() => {}}
      />
    </>
  )
}
