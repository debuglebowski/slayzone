import { use, useRef, useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { X } from 'lucide-react'
import type { LayoutSlot, LayoutTab, PanelInstance, TaskLayout } from '@slayzone/task-contracts'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn
} from '@slayzone/ui'
import { useTaskPageContext } from '../panels/TaskPageContext'
import { LayoutActionsContext, LayoutDragItemContext } from './LayoutContext'
import { newPanelChoiceLike } from './NewPanelMenu'
import { panelTabMeta } from './panelTabMeta'
import type { DragItem } from './layoutDnd'

interface TabStripProps {
  layout: TaskLayout
  slot: LayoutSlot
  /** The group's shown tabs, in order. */
  tabs: readonly LayoutTab[]
  activeId: string
}

/**
 * A group's tab strip: one square tab per shown panel (icon, name, ×), the
 * group's name when it has one. The strip is the group's drag handle as a whole
 * (drag its empty part or name to move the group); each tab drags on its own.
 * Right-click a tab for Rename / New <kind> panel / Split down / Split right / Hide / Close.
 */
export function TabStrip({ layout, slot, tabs, activeId }: TabStripProps): React.JSX.Element {
  const dragItem = use(LayoutDragItemContext)
  const item: DragItem = { type: 'group', slotId: slot.id }
  const { setNodeRef, attributes, listeners } = useDraggable({
    id: `group:${slot.id}`,
    data: { item }
  })
  const groupDragged = dragItem?.type === 'group' && dragItem.slotId === slot.id
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="tablist"
      aria-roledescription="tab group"
      data-tabstrip={slot.id}
      className={cn(
        'shrink-0 h-8 flex items-end gap-px min-w-0 overflow-hidden cursor-grab select-none',
        groupDragged && 'opacity-40'
      )}
    >
      {slot.name && (
        <span className="self-center px-2 text-xs font-medium text-muted-foreground truncate max-w-40">
          {slot.name}
        </span>
      )}
      {tabs.map((t) => {
        const instance = layout.instances[t.instanceId]
        return instance ? (
          <PanelTab
            key={t.instanceId}
            instance={instance}
            selected={t.instanceId === activeId}
            canSplit={slot.tabs.length > 1}
            dimmed={dragItem?.type === 'tab' && dragItem.instanceId === t.instanceId}
          />
        ) : null
      })}
    </div>
  )
}

interface PanelTabProps {
  instance: PanelInstance
  selected: boolean
  /** The group holds another tab to split from. */
  canSplit: boolean
  dimmed: boolean
}

function PanelTab({ instance, selected, canSplit, dimmed }: PanelTabProps): React.JSX.Element {
  const actions = use(LayoutActionsContext)
  const { web, panels } = useTaskPageContext()
  const { label, icon: Icon } = panelTabMeta(instance, web.enabledWebPanels)
  // Another panel like this one, as a tab of this group (step 9 moves it to ⋯).
  const another = panels.canAddPanels ? newPanelChoiceLike(instance, web.enabledWebPanels) : null
  const [renaming, setRenaming] = useState(false)
  // Set by the menu's Rename; the menu's close must then leave focus to the name field.
  const renameRequestedRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const item: DragItem = { type: 'tab', instanceId: instance.id }
  const { setNodeRef, attributes, listeners } = useDraggable({
    id: `tab:${instance.id}`,
    // Never disabled while renaming: that would mark the tab aria-disabled. The
    // name field stops its own pointer events instead.
    data: { item }
  })

  const commitRename = (value: string): void => {
    setRenaming(false)
    if (value.trim() !== (instance.name ?? '')) actions?.renameTab(instance.id, value)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          role="tab"
          aria-selected={selected}
          aria-roledescription="panel tab"
          tabIndex={0}
          data-panel-tab={instance.id}
          title={label}
          onClick={() => actions?.activateTab(instance.id)}
          onKeyDown={(e) => {
            if (renaming) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              actions?.activateTab(instance.id)
            }
          }}
          className={cn(
            // Same box active or not: only colours change, so tabs never shift.
            'group/tab h-7 shrink-0 max-w-48 flex items-center gap-1.5 pl-2.5 pr-1 border border-b-0 rounded-t-sm text-xs cursor-grab outline-none focus-visible:ring-1 focus-visible:ring-ring',
            selected
              ? 'bg-surface-1 border-border text-foreground'
              : 'border-transparent text-muted-foreground hover:bg-surface-2 hover:text-foreground',
            dimmed && 'opacity-35'
          )}
        >
          <Icon className="size-3.5 shrink-0" />
          {renaming ? (
            <input
              ref={inputRef}
              aria-label="Tab name"
              defaultValue={instance.name ?? label}
              className="w-28 min-w-0 bg-transparent text-xs text-foreground outline-none"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commitRename(e.currentTarget.value)
                else if (e.key === 'Escape') setRenaming(false)
              }}
              onBlur={(e) => commitRename(e.currentTarget.value)}
            />
          ) : (
            <span className="truncate">{label}</span>
          )}
          <button
            type="button"
            aria-label={`Close ${label}`}
            title="Close (⌘W)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              actions?.requestCloseTab(instance.id)
            }}
            className={cn(
              'size-4 shrink-0 grid place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground',
              selected
                ? 'opacity-70'
                : 'opacity-0 group-hover/tab:opacity-70 focus-visible:opacity-70'
            )}
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-44"
        onCloseAutoFocus={(e) => {
          if (!renameRequestedRef.current) return
          renameRequestedRef.current = false
          // The menu is gone (it traps focus while open): focus the name field now.
          e.preventDefault()
          requestAnimationFrame(() => {
            inputRef.current?.focus()
            inputRef.current?.select()
          })
        }}
      >
        <ContextMenuItem
          onSelect={() => {
            renameRequestedRef.current = true
            setRenaming(true)
          }}
        >
          Rename
        </ContextMenuItem>
        {another && (
          <ContextMenuItem
            onSelect={() => panels.addPanel(another.kind, instance.id, another.settings)}
          >
            New {another.label} panel
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!canSplit}
          onSelect={() => actions?.splitTab(instance.id, 'after')}
        >
          Split down
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canSplit}
          onSelect={() => actions?.splitTab(instance.id, 'right')}
        >
          Split right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions?.hideTab(instance.id)}>Hide</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions?.requestCloseTab(instance.id)}>
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
