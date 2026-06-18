import type { CSSProperties, ReactNode } from 'react'
import type { DraggableSyntheticListeners } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ProjectDragData } from './tree-view.types'

/**
 * Wraps a project block in a sortable. `renderProject` is a `.map` closure, so
 * a hook can't be called inside it directly — this real component provides the
 * `useSortable` binding via render-prop. `setNodeRef`/`style` go on the project
 * `Collapsible.Root` (the whole block translates); `listeners` go on the header
 * row so the whole header is the grab area. Drag is disabled unless `showAll`
 * (the only mode where the full project list — and thus a complete reorder — is
 * visible). Id is prefixed `project:` so it never collides with task/header ids.
 */
export function SortableProject({
  projectId,
  groupId,
  disabled,
  children
}: {
  projectId: string
  groupId: string | null
  disabled: boolean
  children: (args: {
    setNodeRef: (el: HTMLElement | null) => void
    style: CSSProperties
    listeners: DraggableSyntheticListeners
    isDragging: boolean
  }) => ReactNode
}) {
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({
    id: `project:${projectId}`,
    data: { kind: 'project', projectId, groupId } satisfies ProjectDragData,
    disabled
  })
  // While dragging, the floating preview renders via DragOverlay; the original
  // slot shows an explicit dashed placeholder (Discord behavior). Siblings don't
  // shift (no-op sort strategy on the project context).
  if (isDragging) {
    return (
      <div ref={setNodeRef} className="px-2 py-1">
        <div className="h-8 rounded-md border-2 border-dashed border-primary/50 bg-primary/5" />
      </div>
    )
  }
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }
  return <>{children({ setNodeRef, style, listeners, isDragging })}</>
}
