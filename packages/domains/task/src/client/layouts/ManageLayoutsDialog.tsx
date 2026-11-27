import { useState } from 'react'
import { GripVertical, MoreHorizontal, Pencil, Plus } from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ResolvedLayoutDefinition, TaskLayoutsSetting } from '@slayzone/task-contracts'
import {
  deleteLayouts,
  duplicateLayouts,
  renameLayout,
  reorderLayouts,
  resetBuiltinLayouts,
  setDefaultLayout,
  setLayoutsEnabled,
  shortcutPositionOf
} from '@slayzone/task-contracts'
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  formatKeysForDisplay,
  Input,
  resolveShortcutKeys,
  Switch,
  toast,
  useShortcutStore
} from '@slayzone/ui'
import { usePanelConfig } from '../usePanelConfig'
import { LayoutThumb } from './LayoutThumb'
import { layoutDialogs } from './manageLayoutsStore'
import { resolveClientLayouts, useTaskLayouts } from './useTaskLayouts'
import { useAgentMayChangeLayout } from './useAgentMayChangeLayout'

/**
 * Manage layouts (docs/plans/panel-model.md step 11): every layout, Built-in then
 * Yours, each with an enable switch (disabled = out of the Layout menu and the
 * shortcuts), rename in place, reorder by dragging, and a ⋯ menu (Edit, Duplicate,
 * Make default, Reset, Delete). Selecting rows offers the same actions in bulk.
 */
export function ManageLayoutsDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="manage-layouts-dialog"
        showCloseButton={false}
        className="flex max-h-[min(640px,calc(100vh-4rem))] w-[520px] max-w-[calc(100vw-2rem)] flex-col gap-0 p-0"
      >
        {open && <ManageLayoutsBody onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function ManageLayoutsBody({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { setting, update } = useTaskLayouts()
  const { config } = usePanelConfig()
  const defs = resolveClientLayouts(setting, config)
  const [selected, setSelected] = useState<string[]>([])
  const sel = defs.filter((d) => selected.includes(d.id))
  const builtins = defs.filter((d) => d.builtin)
  const mine = defs.filter((d) => !d.builtin)

  const apply = (fn: (s: TaskLayoutsSetting) => TaskLayoutsSetting | null): void => {
    void update(fn).catch(() => toast.error("Couldn't save your layouts"))
  }
  const setEnabled = (ids: string[], enabled: boolean): void => {
    if (!setLayoutsEnabled(setting, defs, ids, enabled)) {
      toast('Keep at least one layout enabled')
      return
    }
    apply((s) => setLayoutsEnabled(s, defs, ids, enabled))
  }
  const remove = (ids: string[]): void => {
    const gone = ids.filter((id) => mine.some((d) => d.id === id))
    if (gone.length === 0) return
    apply((s) => deleteLayouts(s, gone))
    setSelected((cur) => cur.filter((id) => !gone.includes(id)))
    toast(`Deleted ${gone.length} layout${gone.length > 1 ? 's' : ''}`)
  }
  const duplicate = (ids: string[]): void => {
    let copies: string[] = []
    apply((s) => {
      const out = duplicateLayouts(s, defs, ids)
      copies = out.ids
      return out.setting
    })
    setSelected(copies)
  }
  const reset = (ids: string[]): void => {
    apply((s) => resetBuiltinLayouts(s, ids))
    toast('Reset to the built-in layout')
  }

  /** A section's rows were reordered: they keep the places in the full order they held. */
  const reorderSection = (section: ResolvedLayoutDefinition[], from: string, to: string): void => {
    const ids = section.map((d) => d.id)
    const moved = arrayMove(ids, ids.indexOf(from), ids.indexOf(to))
    const slots = defs.flatMap((d, i) => (ids.includes(d.id) ? [i] : []))
    const order = defs.map((d) => d.id)
    slots.forEach((slot, i) => {
      order[slot] = moved[i]
    })
    apply((s) => reorderLayouts(s, defs, order))
  }

  const toggleSelected = (id: string): void =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const rowProps = {
    defs,
    defaultLayoutId: setting.defaultLayoutId,
    selected,
    onToggleSelected: toggleSelected,
    onRename: (id: string, name: string) => apply((s) => renameLayout(s, id, name)),
    onSetEnabled: (id: string, enabled: boolean) => setEnabled([id], enabled),
    onDuplicate: (id: string) => duplicate([id]),
    onDelete: (id: string) => remove([id]),
    onReset: (id: string) => reset([id]),
    onMakeDefault: (id: string) => apply((s) => setDefaultLayout(s, id)),
    onEdit: (id: string) => layoutDialogs.openEditor({ layoutId: id })
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <DialogTitle className="text-base">Layouts</DialogTitle>
        <span className="flex-1" />
        {sel.length > 0 ? (
          <div className="flex items-center gap-1.5" data-testid="layouts-bulk">
            <span className="text-xs text-muted-foreground">{sel.length} selected</span>
            {sel.some((d) => !d.builtin) && (
              <Button
                size="sm"
                variant="destructive"
                className="h-7"
                data-testid="layouts-bulk-delete"
                onClick={() => remove(selected)}
              >
                Delete
              </Button>
            )}
            {sel.some((d) => d.edited) && (
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                data-testid="layouts-bulk-reset"
                onClick={() => reset(selected)}
              >
                Reset
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              data-testid="layouts-bulk-duplicate"
              onClick={() => duplicate(selected)}
            >
              Duplicate
            </Button>
            {sel.some((d) => d.enabled) && (
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                data-testid="layouts-bulk-disable"
                onClick={() => setEnabled(selected, false)}
              >
                Disable
              </Button>
            )}
            {sel.some((d) => !d.enabled) && (
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                data-testid="layouts-bulk-enable"
                onClick={() => setEnabled(selected, true)}
              >
                Enable
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              data-testid="layouts-bulk-cancel"
              onClick={() => setSelected([])}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1"
            data-testid="layouts-new"
            onClick={() => layoutDialogs.openEditor({ layoutId: null })}
          >
            <Plus className="size-3.5" />
            New layout
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7" onClick={onClose}>
          Done
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <SectionLabel>Built-in</SectionLabel>
        <LayoutSection
          rows={builtins}
          onReorder={(from, to) => reorderSection(builtins, from, to)}
          {...rowProps}
        />
        <SectionLabel>Yours</SectionLabel>
        {mine.length > 0 ? (
          <LayoutSection
            rows={mine}
            onReorder={(from, to) => reorderSection(mine, from, to)}
            {...rowProps}
          />
        ) : (
          <div className="px-3 py-3 text-xs text-muted-foreground" data-testid="layouts-empty">
            Save a layout (Layout menu → Save as…) or add a new one to see it here.
          </div>
        )}
      </div>
      <AgentMayChangeLayoutRow />
    </>
  )
}

/** The `agent_may_change_layout` setting: may agents run `slay panels layout …`? */
export function AgentMayChangeLayoutRow(): React.JSX.Element {
  const { allowed, setAllowed } = useAgentMayChangeLayout()
  return (
    <label
      data-testid="agent-may-change-layout"
      className="flex cursor-pointer items-start gap-2.5 border-t px-4 py-3"
    >
      <Checkbox
        className="mt-0.5"
        checked={allowed}
        onCheckedChange={(v) => setAllowed(v === true)}
        aria-label="Agent may change the layout"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm">Agent may change the layout</span>
        <span className="text-xs text-muted-foreground">
          Agents can open, hide and close panels and switch layouts. Each change can be undone.
        </span>
      </span>
    </label>
  )
}

function SectionLabel({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

interface RowActions {
  defs: readonly ResolvedLayoutDefinition[]
  defaultLayoutId: string
  selected: readonly string[]
  onToggleSelected: (id: string) => void
  onRename: (id: string, name: string) => void
  onSetEnabled: (id: string, enabled: boolean) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onReset: (id: string) => void
  onMakeDefault: (id: string) => void
  onEdit: (id: string) => void
}

function LayoutSection({
  rows,
  onReorder,
  ...actions
}: RowActions & {
  rows: ResolvedLayoutDefinition[]
  onReorder: (from: string, to: string) => void
}): React.JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const onDragEnd = (e: DragEndEvent): void => {
    if (e.over && e.active.id !== e.over.id) onReorder(String(e.active.id), String(e.over.id))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-0.5">
          {rows.map((def) => (
            <LayoutRow key={def.id} def={def} {...actions} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function LayoutRow({
  def,
  defs,
  defaultLayoutId,
  selected,
  onToggleSelected,
  onRename,
  onSetEnabled,
  onDuplicate,
  onDelete,
  onReset,
  onMakeDefault,
  onEdit
}: RowActions & { def: ResolvedLayoutDefinition }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: def.id
  })
  const overrides = useShortcutStore((s) => s.overrides)
  const [name, setName] = useState(def.name)
  const [seenName, setSeenName] = useState(def.name)
  if (def.name !== seenName) {
    setSeenName(def.name)
    setName(def.name)
  }
  const position = shortcutPositionOf(defs, def.id)
  const keys = position ? resolveShortcutKeys(overrides, `switch-layout-${position}`) : null
  const isSelected = selected.includes(def.id)
  const commitName = (): void => {
    if (name.trim() && name.trim() !== def.name) onRename(def.id, name)
    else setName(def.name)
  }
  return (
    <div
      ref={setNodeRef}
      data-testid={`layout-row-${def.id}`}
      data-enabled={def.enabled ? 'true' : 'false'}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1
      }}
      className={cn(
        'group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40',
        isSelected && 'bg-accent/60'
      )}
    >
      <Checkbox
        aria-label={`Select ${def.name}`}
        data-testid="layout-row-select"
        checked={isSelected}
        onCheckedChange={() => onToggleSelected(def.id)}
      />
      <button
        type="button"
        aria-label="Drag to reorder"
        className="flex shrink-0 cursor-grab touch-none items-center gap-1 text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5 opacity-0 group-hover:opacity-100" />
        <LayoutThumb tree={def} className={cn(!def.enabled && 'opacity-40')} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <Input
          aria-label="Layout name"
          data-testid="layout-row-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setName(def.name)
              e.currentTarget.blur()
            }
          }}
          className={cn(
            'h-6 border-transparent bg-transparent px-1 text-sm shadow-none dark:bg-transparent hover:border-input focus-visible:border-input',
            !def.enabled && 'text-muted-foreground'
          )}
        />
        <span className="flex gap-1.5 px-1 text-[10px] text-muted-foreground">
          {def.id === defaultLayoutId && <span data-testid="layout-row-default">Default</span>}
          {def.edited && <span>Edited</span>}
          {!def.enabled && <span>Disabled</span>}
        </span>
      </div>
      {keys && (
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {formatKeysForDisplay(keys)}
        </span>
      )}
      <Switch
        aria-label={def.enabled ? `Disable ${def.name}` : `Enable ${def.name}`}
        data-testid="layout-row-enabled"
        checked={def.enabled}
        onCheckedChange={(on) => onSetEnabled(def.id, on)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More for ${def.name}`}
            data-testid="layout-row-menu"
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem data-testid="layout-row-edit" onSelect={() => onEdit(def.id)}>
            <Pencil className="size-4" />
            Edit layout…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onDuplicate(def.id)}>Duplicate</DropdownMenuItem>
          {def.id !== defaultLayoutId && (
            <DropdownMenuItem
              data-testid="layout-row-make-default"
              onSelect={() => onMakeDefault(def.id)}
            >
              Use for new tasks
            </DropdownMenuItem>
          )}
          {def.edited && (
            <DropdownMenuItem onSelect={() => onReset(def.id)}>Reset to built-in</DropdownMenuItem>
          )}
          {!def.builtin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                data-testid="layout-row-delete"
                onSelect={() => onDelete(def.id)}
              >
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
