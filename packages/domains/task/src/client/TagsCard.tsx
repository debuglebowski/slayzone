import { useState, useEffect, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { Tag } from '@slayzone/tags/shared'
import { TagSelector } from '@slayzone/tags/client'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'

interface TagsCardProps {
  taskId: string
  projectId: string
  tags: Tag[]
  taskTagIds: string[]
  onTagsChange: (tagIds: string[]) => void
  onTagCreated?: (tag: Tag) => void
}

export function TagsCard({
  taskId,
  projectId,
  tags,
  taskTagIds,
  onTagsChange,
  onTagCreated
}: TagsCardProps): React.JSX.Element {
  const trpc = useTRPC()
  const setTagsForTask = useMutation(trpc.tags.setForTask.mutationOptions())

  const handleTagToggle = async (tagId: string, checked: boolean): Promise<void> => {
    if (checked) track('tag_assigned')
    const newTagIds = checked ? [...taskTagIds, tagId] : taskTagIds.filter((id) => id !== tagId)
    await setTagsForTask.mutateAsync({ taskId, tagIds: newTagIds })
    onTagsChange(newTagIds)
  }

  const selectedTags = tags.filter((t) => taskTagIds.includes(t.id))

  // Measure how many tag pills fit in the button
  const [maxVisible, setMaxVisible] = useState(Infinity)
  const measureContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = measureContainerRef.current
    if (!el) return
    const measure = () => {
      const children = Array.from(el.querySelectorAll('[data-tag]')) as HTMLElement[]
      if (children.length === 0) {
        setMaxVisible(Infinity)
        return
      }
      const containerRight = el.getBoundingClientRect().right
      const reserve = children.length > 1 ? 32 : 0
      let count = 0
      for (const child of children) {
        if (child.getBoundingClientRect().right <= containerRight - reserve) count++
        else break
      }
      setMaxVisible(Math.max(1, count))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [selectedTags.length])

  return (
    <div>
      <label className="mb-1 block text-sm text-muted-foreground">Tags</label>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-start p-1 overflow-hidden relative">
            {selectedTags.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <>
                {/* Hidden measurement layer — renders all tags to measure which fit */}
                <div
                  ref={measureContainerRef}
                  className="flex flex-nowrap gap-1 absolute inset-0 p-1 pointer-events-none opacity-0"
                  aria-hidden="true"
                >
                  {selectedTags.map((tag) => (
                    <span
                      key={tag.id}
                      data-tag
                      className="rounded px-1.5 py-1 text-xs font-medium shrink-0"
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
                {/* Visible layer — shows only the tags that fit */}
                <div className="flex flex-nowrap gap-1 min-w-0">
                  {selectedTags.slice(0, maxVisible).map((tag) => (
                    <span
                      key={tag.id}
                      className="rounded px-1.5 py-1 text-xs font-medium shrink-0"
                      style={{ backgroundColor: tag.color, color: tag.text_color }}
                    >
                      {tag.name}
                    </span>
                  ))}
                  {selectedTags.length > maxVisible && (
                    <span
                      data-overflow="true"
                      className="rounded px-1.5 py-1 text-xs font-medium shrink-0 bg-muted text-muted-foreground"
                    >
                      +{selectedTags.length - maxVisible}
                    </span>
                  )}
                </div>
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[200px] p-1.5">
          <TagSelector
            tags={tags}
            selectedTagIds={taskTagIds}
            projectId={projectId}
            onToggle={handleTagToggle}
            onTagCreated={(tag) => {
              onTagCreated?.(tag)
              window.dispatchEvent(new CustomEvent('slayzone:tag-created', { detail: tag }))
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
