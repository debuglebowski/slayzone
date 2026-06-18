import type { ReactNode } from 'react'
import { ChevronDown, Clock, FolderPlus, Pin, Plus, Settings } from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  cn,
  getColumnStatusStyle,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@slayzone/ui'
import { PRIORITY_LABELS } from '@slayzone/tasks'
import { useDialogStore } from '@slayzone/settings'
import { type Task } from '@slayzone/task/shared'
import type { TreeGroup } from '../treeGrouping'
import type { ProjectGroup } from '@slayzone/projects/shared'
import type { GroupDropData, ProjDropMode } from './tree-view.types'

/**
 * Collapsible group label header in the tree. It's a SORTABLE (drag the label
 * to reorder the folder among top-level slots) AND a droppable join target.
 * The gear opens a dropdown → Settings (modal, shared with the rail) / Delete.
 */
export function TreeGroupHeader({
  group,
  line,
  onSettings,
  onDelete
}: {
  group: ProjectGroup
  line: ProjDropMode | null
  onSettings: () => void
  onDelete: () => void
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: `group:${group.id}`,
    data: { kind: 'group', groupId: group.id }
  })
  if (isDragging) {
    return (
      <div ref={setNodeRef} className="px-2">
        <div className="h-7 rounded-md border-2 border-dashed border-primary/50 bg-primary/5" />
      </div>
    )
  }
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <div ref={setNodeRef} style={style} className="relative">
      {/* gap-3 (0.75rem) child → center line at half-gap (-top-1.5). */}
      {line === 'before' && (
        <span className="pointer-events-none absolute -top-1.5 left-2 right-2 z-20 h-1 -translate-y-1/2 rounded-full bg-foreground" />
      )}
      {line === 'after' && (
        <span className="pointer-events-none absolute -bottom-1.5 left-2 right-2 z-20 h-1 translate-y-1/2 rounded-full bg-foreground" />
      )}
      <div
        className={cn(
          'group/gh flex w-full items-center gap-1 rounded-md',
          line === 'merge' && 'bg-primary text-primary-foreground ring-2 ring-inset ring-primary'
        )}
      >
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex flex-1 items-center gap-1 px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 hover:text-foreground transition-colors min-w-0"
            {...attributes}
            {...listeners}
          >
            <ChevronDown
              className={cn(
                'size-3 shrink-0 transition-transform',
                group.collapsed !== 0 && '-rotate-90'
              )}
            />
            <span className="truncate">{group.name.trim() || 'Folder'}</span>
            {line === 'merge' && <FolderPlus className="ml-auto size-3.5" />}
          </button>
        </Collapsible.Trigger>
        {line !== 'merge' && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Settings for ${group.name.trim() || 'folder'}`}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="mr-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground transition-colors"
              >
                <Settings className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onSettings}>Settings</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onDelete} className="text-destructive">
                Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}

export function ContextStaleDot({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span
      aria-label={`${count} stale skill${count === 1 ? '' : 's'}`}
      data-testid="context-manager-stale-dot"
      className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-amber-500"
    />
  )
}

interface HeaderRowProps {
  rowId: string
  projectId: string
  group: TreeGroup
  padTopClass: string
  cols: import('@slayzone/projects/shared').ColumnConfig[] | null
  treeGroupBy: 'none' | 'status' | 'priority'
  onCreateTemporaryTask?: (projectId: string) => void
}

/** DnD wiring for a header row; the temporary header passes an inert object. */
interface HeaderSortable {
  setNodeRef?: (node: HTMLElement | null) => void
  transform: ReturnType<typeof useSortable>['transform']
  transition?: string
  isOver: boolean
}

function HeaderRowView({
  projectId,
  group,
  padTopClass,
  cols,
  treeGroupBy,
  onCreateTemporaryTask,
  sortable
}: HeaderRowProps & { sortable: HeaderSortable }): ReactNode {
  const { setNodeRef, transform, transition, isOver } = sortable
  // Status/priority headers are drop targets — a drop routes through the
  // `kind: 'group'` branch in `handleDragEnd`, landing the dragged set at
  // index 0 of the group. Pinned/none/temp headers reject drops.
  const isDroppable = !group.isTemp && !group.isPinned && !group.isNone

  let label: string
  let Icon: typeof Clock | null = null
  let iconClass: string | undefined
  if (group.isPinned) {
    label = 'Pinned'
    Icon = Pin
    iconClass = 'text-muted-foreground/60 -rotate-45 fill-current'
  } else if (group.isTemp) {
    label = 'Temporary'
    Icon = Clock
    iconClass = 'text-muted-foreground/60'
  } else if (group.isNone) {
    label = 'Other'
  } else if (treeGroupBy === 'priority') {
    const prio = parseInt(group.key.slice(1), 10)
    label = PRIORITY_LABELS[prio] ?? group.key
  } else {
    const style = getColumnStatusStyle(group.key, cols)
    label = style?.label ?? group.key
    Icon = style?.icon ?? null
    iconClass = style?.iconClass
  }

  const showAdd = !group.isPinned && !group.isNone && !(group.isTemp && !onCreateTemporaryTask)

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition
      }}
      data-sidebar-tree-item="header"
      data-group-key={group.key}
      data-testid={isDroppable ? 'tree-status-group' : undefined}
      data-project-id={projectId}
      data-status={group.key}
      className={cn(
        'flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 transition-colors',
        padTopClass,
        isOver && isDroppable && 'bg-accent/15 rounded-md ring-1 ring-accent/30'
      )}
    >
      {Icon && <Icon className={cn('size-3', iconClass)} />}
      <span>{label}</span>
      {showAdd && (
        <button
          type="button"
          onClick={() => {
            if (group.isTemp) {
              onCreateTemporaryTask?.(projectId)
              return
            }
            if (treeGroupBy === 'priority') {
              const prio = parseInt(group.key.slice(1), 10)
              useDialogStore.getState().openCreateTask({
                projectId,
                priority: Number.isFinite(prio) ? prio : undefined
              })
              return
            }
            useDialogStore.getState().openCreateTask({
              projectId,
              status: group.key as Task['status']
            })
          }}
          aria-label={`New ${group.isTemp ? 'temporary ' : ''}task in ${label}`}
          className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground transition-colors"
        >
          <Plus className="size-3" />
        </button>
      )}
    </div>
  )
}

/**
 * Sortable header — a tween-only participant (slides with surrounding rows
 * during pre-slide) and, for status/priority groups, a drop target.
 * `draggable: true` disables drag listeners — headers slide, never drag.
 */
function SortableHeaderRow(props: HeaderRowProps): ReactNode {
  const { rowId, projectId, group } = props
  const isDroppable = !group.isTemp && !group.isPinned && !group.isNone
  const { setNodeRef, transform, transition, isOver } = useSortable({
    id: rowId,
    data: { kind: 'group', projectId, groupValue: group.key } satisfies GroupDropData,
    disabled: { draggable: true, droppable: !isDroppable }
  })
  return <HeaderRowView {...props} sortable={{ setNodeRef, transform, transition, isOver }} />
}

/** Plain header for the temporary group — kept outside the DnD system. */
function PlainHeaderRow(props: HeaderRowProps): ReactNode {
  return (
    <HeaderRowView
      {...props}
      sortable={{ transform: null, transition: undefined, isOver: false }}
    />
  )
}

/** Dispatcher — the temporary group's header skips `useSortable` entirely. */
export function HeaderRow(props: HeaderRowProps): ReactNode {
  return props.group.isTemp ? <PlainHeaderRow {...props} /> : <SortableHeaderRow {...props} />
}
