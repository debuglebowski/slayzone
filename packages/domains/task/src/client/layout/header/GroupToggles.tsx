import { useState } from 'react'
import { Eye, EyeOff, Pencil, PanelsTopLeft, X } from 'lucide-react'
import {
  Button,
  cn,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  PanelToggle,
  type PanelToggleMove,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  withShortcut
} from '@slayzone/ui'
import { PANEL_KINDS } from '../../panels/registry'
import { isRenderableKind, panelTabMeta } from '../panelTabMeta'
import type { LayoutGroup } from './groups'

export interface GroupTogglesProps {
  groups: readonly LayoutGroup[]
  webPanels: readonly { id: string; name: string }[]
  /** `toggles`: one icon button per group; `menu`: a Panels dropdown listing them. */
  mode: 'toggles' | 'menu'
  align: 'start' | 'end'
  onToggle: (group: LayoutGroup, active: boolean) => void
  /** The shortcut that toggles a group (it holds a kind's primary panel), if any. */
  shortcutOf: (group: LayoutGroup) => string | null
  /** Drag-reorder of the toggles (absent: not draggable). */
  onReorder?: (orderedSlotIds: string[], move: PanelToggleMove) => void
  /** Name a group (blank = named from its contents). Absent: no Rename. */
  onRename?: (slotId: string, name: string) => void
  /** Close every panel of a group. Absent: no Close. */
  onClose?: (group: LayoutGroup) => void
  /** Move a group's panels into another shown group as tabs. Absent: no "Add as a tab to". */
  onAddAsTab?: (group: LayoutGroup, target: LayoutGroup) => void
}

function iconOf(group: LayoutGroup, webPanels: GroupTogglesProps['webPanels']) {
  return panelTabMeta(group.iconInstance, webPanels).icon
}

function iconClassOf(group: LayoutGroup): string | undefined {
  const kind = group.iconInstance.kind
  return isRenderableKind(kind) ? PANEL_KINDS[kind].iconClassName : undefined
}

/**
 * The title row's group toggles (docs/plans/panel-model.md step 9): one toggle per
 * tab group, showing or hiding the whole group in place. Its icon is the group's
 * shown panel, coloured; a hidden group is gray. Right-click: Rename / Hide / Close,
 * and "Add as a tab to" another shown group.
 */
export function GroupToggles({
  groups,
  webPanels,
  mode,
  align,
  onToggle,
  shortcutOf,
  onReorder,
  onRename,
  onClose,
  onAddAsTab
}: GroupTogglesProps): React.JSX.Element | null {
  const [renaming, setRenaming] = useState<LayoutGroup | null>(null)
  if (groups.length === 0) return null
  const bySlot = new Map(groups.map((g) => [g.slotId, g]))

  const renameDialog = (
    <Dialog
      open={renaming !== null}
      onOpenChange={(open) => {
        if (!open) setRenaming(null)
      }}
    >
      <DialogContent className="max-w-sm" data-testid="rename-group-dialog">
        <DialogHeader>
          <DialogTitle>Rename group</DialogTitle>
        </DialogHeader>
        {renaming && (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault()
              const value = new FormData(e.currentTarget).get('name')
              onRename?.(renaming.slotId, typeof value === 'string' ? value : '')
              setRenaming(null)
            }}
          >
            <Input
              name="name"
              aria-label="Group name"
              autoFocus
              defaultValue={renaming.customName ?? ''}
              placeholder={renaming.autoName}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )

  if (mode === 'menu') {
    const activeCount = groups.filter((g) => g.active).length
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Panels"
                className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 hover:bg-surface-3 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <PanelsTopLeft className="size-4" />
                {activeCount > 0 && (
                  <span className="tabular-nums text-[10px] text-muted-foreground/80">
                    {activeCount}
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Panels</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align={align} className="w-max min-w-48 max-w-80">
          {groups.map((g) => {
            const Icon = iconOf(g, webPanels)
            const shortcut = shortcutOf(g)
            return (
              <DropdownMenuItem
                key={g.slotId}
                onSelect={(e) => {
                  e.preventDefault()
                  onToggle(g, !g.active)
                }}
                className={cn('cursor-pointer gap-2', g.active && 'bg-accent/50')}
              >
                <Icon
                  className={cn('size-4', g.active ? iconClassOf(g) : 'text-muted-foreground')}
                />
                <span className="flex-1 truncate">{g.name}</span>
                {shortcut && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">{shortcut}</span>
                )}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const renderContextMenu = (slotId: string): React.ReactNode => {
    const group = bySlot.get(slotId)
    if (!group) return null
    const targets = onAddAsTab ? groups.filter((g) => g.active && g.slotId !== slotId) : []
    return (
      <>
        <ContextMenuLabel className="truncate max-w-56">{group.name}</ContextMenuLabel>
        {onRename && (
          <ContextMenuItem onSelect={() => setRenaming(group)}>
            <Pencil className="size-3.5" />
            Rename
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => onToggle(group, !group.active)}>
          {group.active ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {group.active ? 'Hide' : 'Show'}
        </ContextMenuItem>
        {onClose && (
          <ContextMenuItem onSelect={() => onClose(group)}>
            <X className="size-3.5" />
            Close group
          </ContextMenuItem>
        )}
        {targets.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuLabel>Add as a tab to</ContextMenuLabel>
            {targets.map((t) => {
              const Icon = iconOf(t, webPanels)
              return (
                <ContextMenuItem key={t.slotId} onSelect={() => onAddAsTab?.(group, t)}>
                  <Icon className="size-3.5" />
                  {t.name}
                </ContextMenuItem>
              )
            })}
          </>
        )}
      </>
    )
  }

  return (
    <>
      <PanelToggle
        variant="icons"
        data-testid="panel-toggles"
        panels={groups.map((g) => ({
          id: g.slotId,
          icon: iconOf(g, webPanels),
          iconClassName: iconClassOf(g),
          label: g.name,
          active: g.active,
          tooltip: withShortcut(g.name, shortcutOf(g))
        }))}
        onChange={(slotId, active) => {
          const group = bySlot.get(slotId)
          if (group) onToggle(group, active)
        }}
        onReorder={onReorder}
        renderContextMenu={renderContextMenu}
      />
      {renameDialog}
    </>
  )
}
