import type { LucideIcon } from 'lucide-react'
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  arrayMove,
  horizontalListSortingStrategy
} from '@dnd-kit/sortable'
import { restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'

import { cn } from './utils'
import { Tooltip, TooltipTrigger, TooltipContent } from './tooltip'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './context-menu'
import { withShortcut } from '@slayzone/shortcuts'

interface PanelToggleItem {
  id: string
  icon: LucideIcon
  label: string
  active: boolean
  shortcut?: string | null
  disabled?: boolean
}

interface PanelToggleProps {
  panels: PanelToggleItem[]
  onChange: (id: string, active: boolean) => void
  /**
   * When provided, buttons become drag-reorderable. Receives the full new id
   * order on drop. A plain click still toggles — a drag past the 6px threshold
   * reorders instead.
   */
  onReorder?: (orderedIds: string[]) => void
  /** Right-click menu items for a panel's button; null/undefined = no menu. */
  renderContextMenu?: (id: string) => ReactNode
  variant?: 'raised' | 'flat'
  className?: string
}

const variantStyles = {
  raised: {
    container: 'bg-muted',
    active: 'bg-muted-foreground/20 text-foreground shadow-sm',
    activeDisabled: 'bg-muted-foreground/20 text-foreground/40 shadow-sm cursor-not-allowed'
  },
  flat: {
    container: 'bg-surface-2',
    active: 'bg-surface-3 text-foreground shadow-sm',
    activeDisabled: 'bg-surface-3 text-foreground/40 shadow-sm cursor-not-allowed'
  }
}

type VariantStyle = (typeof variantStyles)['flat']

interface PanelButtonProps {
  panel: PanelToggleItem
  styles: VariantStyle
  onChange: (id: string, active: boolean) => void
  draggable: boolean
  dragRef?: Ref<HTMLButtonElement>
  dragProps?: HTMLAttributes<HTMLButtonElement>
  style?: CSSProperties
  isDragging?: boolean
  renderContextMenu?: (id: string) => ReactNode
}

function PanelButton({
  panel,
  styles,
  onChange,
  draggable,
  dragRef,
  dragProps,
  style,
  isDragging,
  renderContextMenu
}: PanelButtonProps) {
  const menu = renderContextMenu?.(panel.id)
  const button = (
    <button
      ref={dragRef}
      style={style}
      {...dragProps}
      onClick={() => onChange(panel.id, !panel.active)}
      aria-pressed={panel.active}
      disabled={panel.disabled}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
        draggable && !panel.disabled && 'cursor-grab active:cursor-grabbing touch-none',
        isDragging && 'opacity-60',
        panel.disabled
          ? panel.active
            ? styles.activeDisabled
            : 'text-muted-foreground/40 cursor-not-allowed'
          : panel.active
            ? styles.active
            : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <panel.icon className="size-3.5" />
      {panel.label}
      {panel.shortcut && (
        <span
          className={cn(
            'ml-1 text-[10px]',
            panel.active ? 'text-muted-foreground' : 'text-muted-foreground/60'
          )}
        >
          {panel.shortcut}
        </span>
      )}
    </button>
  )
  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          {menu ? <ContextMenuTrigger asChild>{button}</ContextMenuTrigger> : button}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {panel.disabled
            ? `Select a project to use ${panel.label}`
            : withShortcut(
                `${panel.active ? 'Hide' : 'Show'} ${panel.label} panel`,
                panel.shortcut ?? null
              )}
        </TooltipContent>
      </Tooltip>
      {menu && <ContextMenuContent className="min-w-48">{menu}</ContextMenuContent>}
    </ContextMenu>
  )
}

function SortablePanelButton({
  panel,
  styles,
  onChange,
  renderContextMenu
}: Pick<PanelButtonProps, 'panel' | 'styles' | 'onChange' | 'renderContextMenu'>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: panel.id,
    disabled: panel.disabled
  })
  return (
    <PanelButton
      panel={panel}
      styles={styles}
      onChange={onChange}
      draggable
      dragRef={setNodeRef}
      dragProps={{ ...attributes, ...listeners }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined
      }}
      isDragging={isDragging}
      renderContextMenu={renderContextMenu}
    />
  )
}

export function PanelToggle({
  panels,
  onChange,
  onReorder,
  renderContextMenu,
  variant = 'flat',
  className
}: PanelToggleProps) {
  const styles = variantStyles[variant]
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const containerClass = cn(
    'flex items-center rounded-lg p-1 gap-1 overflow-x-auto scrollbar-hide',
    styles.container,
    className
  )

  if (!onReorder) {
    return (
      <div className={containerClass}>
        {panels.map((panel) => (
          <PanelButton
            key={panel.id}
            panel={panel}
            styles={styles}
            onChange={onChange}
            draggable={false}
            renderContextMenu={renderContextMenu}
          />
        ))}
      </div>
    )
  }

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = panels.map((p) => p.id)
    const oldIdx = ids.indexOf(String(active.id))
    const newIdx = ids.indexOf(String(over.id))
    if (oldIdx < 0 || newIdx < 0) return
    onReorder(arrayMove(ids, oldIdx, newIdx))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
      autoScroll={false}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={panels.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
        <div className={containerClass}>
          {panels.map((panel) => (
            <SortablePanelButton
              key={panel.id}
              panel={panel}
              styles={styles}
              onChange={onChange}
              renderContextMenu={renderContextMenu}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
