import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, EyeOff, X } from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import type {
  LayoutColumn,
  LayoutSlot,
  LayoutTree,
  PanelConfig,
  PanelInstanceSettings,
  ResolvedLayoutDefinition
} from '@slayzone/task-contracts'
import {
  addInstance,
  addUserLayout,
  closeInstance,
  definitionTreeOf,
  instanceDefaultLayout,
  renameLayout,
  saveLayoutTree,
  setSlotHidden
} from '@slayzone/task-contracts'
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  toast,
  useStableCallback
} from '@slayzone/ui'
import { applyDrop, zoneAt, type Box, type DragItem, type DropZone } from '../layout/layoutDnd'
import { panelTabMeta } from '../layout/panelTabMeta'
import { PANEL_KINDS, type PanelKind } from '../panels/registry'
import { usePanelConfig } from '../usePanelConfig'
import type { LayoutEditorTarget } from './manageLayoutsStore'
import { resolveClientLayouts, useTaskLayouts } from './useTaskLayouts'

/** A panel type in the palette: dragging it onto the layout adds an instance. */
interface PaletteEntry {
  key: string
  kind: PanelKind
  label: string
  settings?: PanelInstanceSettings
}

/** What a drag carries in the editor: a palette entry, or a tab of the layout. */
type EditorDragItem = DragItem | { type: 'new'; entry: PaletteEntry }

type EditorHit =
  | { type: 'zone'; slotId: string; zone: DropZone; rect: Box }
  /** The empty canvas: the panel becomes the first column. */
  | { type: 'canvas'; rect: Box }

const PALETTE_KINDS: readonly PanelKind[] = [
  'agent',
  'terminal',
  'browser',
  'editor',
  'git',
  'artifacts',
  'processes',
  'settings'
]

/** A new layout's start: one agent panel. */
function starterTree(config: PanelConfig): LayoutTree {
  return {
    columns: [
      {
        id: 'terminal',
        size: instanceDefaultLayout('agent', {}, config),
        slots: [
          {
            id: 'terminal',
            weight: 1,
            activeInstanceId: 'terminal',
            tabs: [{ instanceId: 'terminal' }]
          }
        ]
      }
    ],
    instances: { terminal: { id: 'terminal', kind: 'agent', settings: {} } }
  }
}

/**
 * The layout editor (docs/plans/panel-model.md step 11): build a layout by dragging
 * panel types from the palette onto it — with the task view's drop zones: a group's
 * outer 20% left/right opens a column, its outer 30% top/bottom a group above or
 * below, the middle adds a tab. Tabs drag between groups the same way; × removes
 * one, the eye hides a group (it starts hidden, its toggle stays in the title row).
 * Edits a LayoutDefinition, never a task. Save stores it in task_layouts.
 */
export function LayoutEditorDialog({
  target,
  onClose
}: {
  target: LayoutEditorTarget | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="layout-editor"
        // Stacked over Manage layouts, which already dims and blurs the app: a second
        // blur layer repaints the whole window under every drag frame.
        overlayClassName="backdrop-blur-none"
        showCloseButton={false}
        className="flex h-[min(600px,calc(100vh-4rem))] w-[860px] max-w-[calc(100vw-2rem)] flex-col gap-0 p-0"
      >
        {target && <EditorBody target={target} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function EditorBody({
  target,
  onClose
}: {
  target: LayoutEditorTarget
  onClose: () => void
}): React.JSX.Element {
  const { setting, update } = useTaskLayouts()
  const { config, enabledWebPanels } = usePanelConfig()
  const defs = resolveClientLayouts(setting, config)
  const editing: ResolvedLayoutDefinition | null = target.layoutId
    ? (defs.find((d) => d.id === target.layoutId) ?? null)
    : null
  const [name, setName] = useState(() => editing?.name ?? target.seed?.name ?? 'New layout')
  const [tree, setTree] = useState<LayoutTree>(() =>
    definitionTreeOf(editing ?? target.seed?.tree ?? starterTree(config))
  )

  const palette: PaletteEntry[] = [
    ...PALETTE_KINDS.map((kind) => ({ key: kind, kind, label: PANEL_KINDS[kind].label })),
    ...enabledWebPanels.map((wp) => ({
      key: wp.id,
      kind: 'web' as const,
      label: wp.name,
      settings: { panelId: wp.id }
    }))
  ]
  const present = (entry: PaletteEntry): boolean =>
    Object.values(tree.instances).some(
      (i) => i.kind === entry.kind && (entry.kind !== 'web' || i.settings.panelId === entry.key)
    )
  // Single-instance kinds (settings) and web panels (one per configured page) only once.
  const usable = (entry: PaletteEntry): boolean =>
    !present(entry) || (PANEL_KINDS[entry.kind].multiInstance && entry.kind !== 'web')

  const drop = (item: EditorDragItem, hit: EditorHit): void => {
    setTree((current) => {
      if (item.type === 'new') {
        const { kind, settings } = item.entry
        const opts = { settings, size: instanceDefaultLayout(kind, settings ?? {}, config) }
        if (hit.type === 'canvas')
          return addInstance(current, kind, { type: 'column' }, opts).layout
        const placement =
          hit.zone === 'merge'
            ? ({ type: 'tab', slotId: hit.slotId } as const)
            : ({ type: 'split', slotId: hit.slotId, zone: hit.zone } as const)
        return addInstance(current, kind, placement, opts).layout
      }
      if (hit.type === 'canvas') return current
      return (
        applyDrop(current, item, { type: 'zone', slotId: hit.slotId, zone: hit.zone }) ?? current
      )
    })
  }

  const empty = Object.keys(tree.instances).length === 0
  const save = (): void => {
    if (empty) return
    const id = editing?.id ?? null
    void update((s) => {
      if (id) return renameLayout(saveLayoutTree(s, id, tree), id, name)
      return addUserLayout(s, defs, name, tree).setting
    })
      .then(() => {
        toast.success(`Saved “${name.trim() || 'Untitled layout'}”`)
        onClose()
      })
      .catch(() => toast.error("Couldn't save the layout"))
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <DialogTitle className="text-base">{editing ? 'Edit layout' : 'New layout'}</DialogTitle>
        <Input
          aria-label="Layout name"
          data-testid="layout-editor-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-7 max-w-64"
        />
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose} data-testid="layout-editor-cancel">
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={empty || name.trim() === ''}
          onClick={save}
          data-testid="layout-editor-save"
        >
          Save
        </Button>
      </div>
      <EditorDnd onDrop={drop} tree={tree} webPanels={enabledWebPanels}>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3">
            <div className="pb-1 text-xs text-muted-foreground">
              Drag onto the layout: an edge places it, the middle adds a tab.
            </div>
            {palette.map((entry) => (
              <PaletteItem key={entry.key} entry={entry} disabled={!usable(entry)} />
            ))}
          </div>
          <div className="flex min-w-0 flex-1 p-3" data-editor-canvas="">
            {empty ? (
              <div className="flex flex-1 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
                Drag a panel here
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 gap-1.5">
                {tree.columns.map((column) => (
                  <EditorColumn
                    key={column.id}
                    tree={tree}
                    column={column}
                    webPanels={enabledWebPanels}
                    onRemove={(id) => setTree((t) => closeInstance(t, id))}
                    onToggleHidden={(slot) =>
                      setTree((t) => setSlotHidden(t, slot.id, !slot.hidden))
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </EditorDnd>
    </>
  )
}

function columnFlex(column: LayoutColumn): number {
  const { unit, value } = column.size
  if (unit === 'fr') return Math.max(0.5, value)
  if (unit === 'pct') return Math.max(0.5, value / 25)
  return Math.max(0.5, value / 320)
}

function EditorColumn({
  tree,
  column,
  webPanels,
  onRemove,
  onToggleHidden
}: {
  tree: LayoutTree
  column: LayoutColumn
  webPanels: readonly { id: string; name: string }[]
  onRemove: (instanceId: string) => void
  onToggleHidden: (slot: LayoutSlot) => void
}): React.JSX.Element {
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      style={{ flex: columnFlex(column) }}
      data-editor-column={column.id}
    >
      {column.slots.map((slot) => (
        <div
          key={slot.id}
          data-editor-slot={slot.id}
          data-testid="layout-editor-slot"
          data-hidden={slot.hidden ? 'true' : undefined}
          className={cn(
            'flex min-h-16 min-w-0 flex-col rounded-md border bg-surface-1',
            slot.hidden && 'border-dashed opacity-60'
          )}
          style={{ flex: slot.weight }}
        >
          <div className="flex min-w-0 items-center gap-1 border-b px-1 py-1">
            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {slot.tabs.map((tab) => {
                const inst = tree.instances[tab.instanceId]
                if (!inst) return null
                return (
                  <EditorTab
                    key={tab.instanceId}
                    instanceId={tab.instanceId}
                    kind={inst.kind}
                    label={panelTabMeta(inst, webPanels).label}
                    onRemove={() => onRemove(tab.instanceId)}
                  />
                )
              })}
            </div>
            <button
              type="button"
              aria-label={slot.hidden ? 'Show this group' : 'Hide this group'}
              title={
                slot.hidden
                  ? 'Starts hidden: its toggle shows it'
                  : 'Start hidden (its toggle stays in the title row)'
              }
              data-testid="layout-editor-slot-visibility"
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onToggleHidden(slot)}
            >
              {slot.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
          <div className="flex-1" />
        </div>
      ))}
    </div>
  )
}

function EditorTab({
  instanceId,
  kind,
  label,
  onRemove
}: {
  instanceId: string
  kind: string
  label: string
  onRemove: () => void
}): React.JSX.Element {
  const item: EditorDragItem = { type: 'tab', instanceId }
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `tab:${instanceId}`,
    data: { item }
  })
  const def = kind in PANEL_KINDS ? PANEL_KINDS[kind as PanelKind] : null
  const Icon = def?.icon
  return (
    <span
      ref={setNodeRef}
      data-testid={`layout-editor-tab-${instanceId}`}
      data-kind={kind}
      className={cn(
        'inline-flex max-w-full cursor-grab touch-none items-center gap-1 rounded bg-surface-3 py-0.5 pr-0.5 pl-1.5 text-xs',
        isDragging && 'opacity-40'
      )}
      {...attributes}
      {...listeners}
    >
      {Icon && <Icon className={cn('size-3 shrink-0', def?.iconClassName)} />}
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        className="flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function PaletteItem({
  entry,
  disabled
}: {
  entry: PaletteEntry
  disabled: boolean
}): React.JSX.Element {
  const item: EditorDragItem = { type: 'new', entry }
  const { setNodeRef, attributes, listeners } = useDraggable({
    id: `palette:${entry.key}`,
    data: { item },
    disabled
  })
  const def = PANEL_KINDS[entry.kind]
  return (
    <div
      ref={setNodeRef}
      data-testid={`layout-editor-palette-${entry.key}`}
      title={disabled ? 'Already in the layout' : `Drag to place ${entry.label}`}
      className={cn(
        'flex touch-none items-center gap-2 rounded-md border px-2 py-1.5 text-sm',
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-grab hover:bg-accent/50'
      )}
      {...attributes}
      {...listeners}
    >
      <def.icon className={cn('size-4 shrink-0', def.iconClassName)} />
      <span className="truncate">{entry.label}</span>
    </div>
  )
}

function toBox(r: DOMRect): Box {
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/** What the pointer at (x, y) is over inside the editor: a group's zone, the empty canvas, or nothing. */
function editorHitTest(root: HTMLElement, x: number, y: number): EditorHit | null {
  const el = document.elementsFromPoint(x, y).find((e) => root.contains(e))
  if (!el) return null
  const slot = el.closest<HTMLElement>('[data-editor-slot]')
  if (slot) {
    const r = slot.getBoundingClientRect()
    return {
      type: 'zone',
      slotId: slot.dataset.editorSlot ?? '',
      zone: zoneAt(r, x, y),
      rect: toBox(r)
    }
  }
  const canvas = el.closest<HTMLElement>('[data-editor-canvas]')
  if (canvas && !canvas.querySelector('[data-editor-slot]'))
    return { type: 'canvas', rect: toBox(canvas.getBoundingClientRect()) }
  return null
}

/**
 * The editor's drag and drop: dnd-kit sensors and overlay, the target hit-tested
 * from the pointer (like the task view's LayoutDnd, on the editor's own DOM).
 */
function EditorDnd({
  tree,
  webPanels,
  onDrop,
  children
}: {
  tree: LayoutTree
  webPanels: readonly { id: string; name: string }[]
  onDrop: (item: EditorDragItem, hit: EditorHit) => void
  children: React.ReactNode
}): React.JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{ item: EditorDragItem; hit: EditorHit | null } | null>(null)
  const dragRef = useRef<{ item: EditorDragItem; hit: EditorHit | null } | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  useEffect(() => () => stopRef.current?.(), [])

  const track = useStableCallback((x: number, y: number) => {
    const current = dragRef.current
    const root = rootRef.current
    if (!current || !root) return
    const hit = editorHitTest(root, x, y)
    const key = (h: EditorHit | null): string =>
      !h ? '' : h.type === 'canvas' ? 'canvas' : `${h.slotId}|${h.zone}`
    if (key(hit) === key(current.hit)) return
    const next = { ...current, hit }
    dragRef.current = next
    setDrag(next)
  })

  const finish = (commit: boolean): void => {
    stopRef.current?.()
    stopRef.current = null
    const current = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (commit && current?.hit) onDrop(current.item, current.hit)
  }

  const label = (item: EditorDragItem): string => {
    if (item.type === 'new') return item.entry.label
    if (item.type === 'tab') {
      const inst = tree.instances[item.instanceId]
      return inst ? panelTabMeta(inst, webPanels).label : ''
    }
    return ''
  }

  const hit = drag?.hit ?? null
  return (
    <div ref={rootRef} className="flex min-h-0 flex-1">
      <DndContext
        sensors={sensors}
        autoScroll={false}
        accessibility={{ container: document.body }}
        onDragStart={(event) => {
          const item = (event.active.data.current as { item?: EditorDragItem } | undefined)?.item
          if (!item) return
          const next = { item, hit: null }
          dragRef.current = next
          setDrag(next)
          const onMove = (e: PointerEvent): void => track(e.clientX, e.clientY)
          window.addEventListener('pointermove', onMove, true)
          stopRef.current = () => window.removeEventListener('pointermove', onMove, true)
        }}
        onDragEnd={() => finish(true)}
        onDragCancel={() => finish(false)}
      >
        {children}
        {hit && createPortal(<EditorDropIndicator hit={hit} />, document.body)}
        {createPortal(
          <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
            {drag ? (
              <div className="inline-flex items-center rounded-md border border-primary bg-surface-3 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg -rotate-2">
                {label(drag.item)}
              </div>
            ) : null}
          </DragOverlay>,
          document.body
        )}
      </DndContext>
    </div>
  )
}

function EditorDropIndicator({ hit }: { hit: EditorHit }): React.JSX.Element {
  const r = hit.rect
  let box: Box = r
  if (hit.type === 'zone' && hit.zone !== 'merge') {
    const w = r.width * 0.45
    const h = r.height * 0.45
    box =
      hit.zone === 'left'
        ? { ...r, width: w }
        : hit.zone === 'right'
          ? { ...r, left: r.left + r.width - w, width: w }
          : hit.zone === 'before'
            ? { ...r, height: h }
            : { ...r, top: r.top + r.height - h, height: h }
  }
  return (
    <div
      aria-hidden
      data-testid="layout-editor-drop-indicator"
      data-drop={hit.type === 'zone' ? hit.zone : 'canvas'}
      className="pointer-events-none fixed z-[60] rounded-lg border-2 border-primary bg-primary/15"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    />
  )
}
