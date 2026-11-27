import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import type { TaskLayout } from '@slayzone/task-contracts'
import { findSlot, findTab } from '@slayzone/task-contracts'
import { useStableCallback } from '@slayzone/ui'
import { useTaskPageContext } from '../panels/TaskPageContext'
import { LayoutDragItemContext } from './LayoutContext'
import {
  dropPreview,
  stripIndexAt,
  targetKey,
  zoneAt,
  type Box,
  type DragItem,
  type DropPreview,
  type DropTarget
} from './layoutDnd'
import { panelTabMeta } from './panelTabMeta'

/** How long the drop settles (FLIP) before native views come back. */
export const DROP_SETTLE_MS = 170
const SETTLE_EASING = 'cubic-bezier(.2,.9,.25,1)'

interface Hit {
  target: DropTarget
  /** The group (zone) or strip (strip) the pointer is over. */
  rect: Box
  /** Strip targets: x of the insertion marker. */
  markX?: number
}

interface DragState {
  item: DragItem
  root: HTMLElement
  hit: Hit | null
}

function toBox(r: DOMRect): Box {
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/**
 * What the pointer at (x, y) would drop on inside `root`: a tab strip (merge at an
 * index), a group's body (zone by position), `keep` over something in between
 * (a divider, the gap: the previous target stays), null outside the strip.
 */
function hitTest(root: HTMLElement, layout: TaskLayout, x: number, y: number): Hit | 'keep' | null {
  // The topmost element of the strip under the pointer: anything floating above it
  // (a tooltip, a toast, the drag chip) does not hide the target.
  const el = document.elementsFromPoint(x, y).find((e) => root.contains(e))
  if (!el) return null
  const strip = el.closest<HTMLElement>('[data-tabstrip]')
  if (strip && root.contains(strip)) {
    const slotId = strip.dataset.tabstrip ?? ''
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[data-panel-tab]')).map((t) =>
      t.getBoundingClientRect()
    )
    const index = stripIndexAt(x, tabs)
    const sr = strip.getBoundingClientRect()
    const markX = index < tabs.length ? tabs[index].left : (tabs.at(-1)?.right ?? sr.left)
    return { target: { type: 'strip', slotId, index }, rect: toBox(sr), markX }
  }
  const slotEl = el.closest<HTMLElement>('[data-slot-id]')
  let slotId: string | undefined
  let rectEl: HTMLElement | null = null
  if (slotEl && root.contains(slotEl)) {
    slotId = slotEl.dataset.slotId
    rectEl = slotEl
  } else {
    // A bare (Classic) group is just its panel's frame.
    const frame = el.closest<HTMLElement>('[data-panel-id]')
    const loc = frame?.dataset.panelId ? findTab(layout, frame.dataset.panelId) : null
    if (frame && loc) {
      slotId = layout.columns[loc.columnIndex].slots[loc.slotIndex].id
      rectEl = frame
    }
  }
  if (!slotId || !rectEl || !findSlot(layout, slotId)) return 'keep'
  const r = rectEl.getBoundingClientRect()
  return { target: { type: 'zone', slotId, zone: zoneAt(r, x, y) }, rect: toBox(r) }
}

/** Client rects of the panels and tabs in `root`, keyed by panel / tab id. */
function measure(root: HTMLElement): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-panel-id], [data-panel-tab]')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    rects.set(el.dataset.panelTab ? `tab:${el.dataset.panelTab}` : `panel:${el.dataset.panelId}`, r)
  }
  return rects
}

/** Animate every panel and tab from where it was (`first`) to where it is now. */
function settle(root: HTMLElement, first: Map<string, DOMRect>): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-panel-id], [data-panel-tab]')) {
    const key = el.dataset.panelTab ? `tab:${el.dataset.panelTab}` : `panel:${el.dataset.panelId}`
    const last = el.getBoundingClientRect()
    if (last.width === 0 || last.height === 0) continue
    const was = first.get(key)
    if (!was) {
      el.animate(
        [
          { opacity: 0, transform: 'scale(.97)' },
          { opacity: 1, transform: 'none' }
        ],
        {
          duration: DROP_SETTLE_MS,
          easing: SETTLE_EASING
        }
      )
      continue
    }
    const dx = was.left - last.left
    const dy = was.top - last.top
    const sx = el.dataset.panelTab ? 1 : was.width / last.width
    const sy = el.dataset.panelTab ? 1 : was.height / last.height
    if (
      Math.abs(dx) < 1 &&
      Math.abs(dy) < 1 &&
      Math.abs(sx - 1) < 0.005 &&
      Math.abs(sy - 1) < 0.005
    )
      continue
    el.animate(
      [
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: '0 0', transform: 'none' }
      ],
      { duration: DROP_SETTLE_MS, easing: SETTLE_EASING }
    )
  }
}

interface LayoutDndProps {
  layout: TaskLayout
  /** A drop on a target (the caller applies `applyDrop`; a no-op changes nothing). */
  onDrop: (item: DragItem, target: DropTarget) => void
  /** A drag starts / has settled: native views hide and terminals pause meanwhile. */
  onDraggingChange: (dragging: boolean) => void
  children: ReactNode
}

/**
 * Drag and drop of panel tabs and groups (dnd-kit sensors and overlay; the drop
 * target is hit-tested from the pointer, see `hitTest`). While dragging NOTHING
 * in the layout moves: the dragged tab dims, the target zone is outlined, a
 * strip shows an insertion marker. On drop the layout changes once and every
 * panel and tab settles into its new place (FLIP).
 */
export function LayoutDnd({
  layout,
  onDrop,
  onDraggingChange,
  children
}: LayoutDndProps): React.JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  // `drag` renders the indicator; `dragRef` is the live drag the handlers read.
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const pendingSettleRef = useRef<{ root: HTMLElement; first: Map<string, DOMRect> } | null>(null)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Removes the drag's pointer listener (see handleDragStart).
  const stopTrackingRef = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      stopTrackingRef.current?.()
    },
    []
  )

  // The drop's layout is committed: animate from the measured "before".
  useLayoutEffect(() => {
    const pending = pendingSettleRef.current
    if (!pending) return
    pendingSettleRef.current = null
    settle(pending.root, pending.first)
  }, [layout])

  /** Hit-test the pointer at (x, y); a new target re-renders the indicator. */
  const trackPointer = useStableCallback((x: number, y: number) => {
    const current = dragRef.current
    if (!current) return
    const hit = hitTest(current.root, layout, x, y)
    if (hit === 'keep' || targetKey(hit?.target ?? null) === targetKey(current.hit?.target ?? null))
      return
    const next = { ...current, hit }
    dragRef.current = next
    setDrag(next)
  })

  const handleDragStart = useStableCallback((event: DragStartEvent) => {
    const item = (event.active.data.current as { item?: DragItem } | undefined)?.item
    const source = event.activatorEvent.target
    const root = source instanceof Element ? source.closest<HTMLElement>('#task-panels') : null
    if (!item || !root) return
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    const next = { item, root, hit: null }
    dragRef.current = next
    setDrag(next)
    onDraggingChange(true)
    // The pointer itself, not dnd-kit's delta: that one comes from its rendered
    // state, which may lag the last moves when the pointer is released quickly.
    const onMove = (e: PointerEvent): void => trackPointer(e.clientX, e.clientY)
    window.addEventListener('pointermove', onMove, true)
    stopTrackingRef.current?.()
    stopTrackingRef.current = () => window.removeEventListener('pointermove', onMove, true)
  })

  // The live drag is read from the ref, not state: the pointer may be released
  // before the last move's render.
  const finish = (current: DragState | null, commit: boolean): void => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    dragRef.current = null
    setDrag(null)
    if (commit && current?.hit) {
      pendingSettleRef.current = { root: current.root, first: measure(current.root) }
      onDrop(current.item, current.hit.target)
    }
    // Native views come back once the panels have settled.
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = setTimeout(
      () => {
        settleTimerRef.current = null
        // A drop that changed nothing never commits a layout: drop the stale "before".
        pendingSettleRef.current = null
        onDraggingChange(false)
      },
      commit ? DROP_SETTLE_MS : 0
    )
  }
  const handleDragEnd = useStableCallback((_event: DragEndEvent) => finish(dragRef.current, true))
  const handleDragCancel = useStableCallback(() => finish(dragRef.current, false))

  const preview = drag ? dropPreview(layout, drag.item, drag.hit?.target ?? null) : null

  return (
    <DndContext
      sensors={sensors}
      autoScroll={false}
      // Its screen-reader live region goes to <body>: inline it would be a child of
      // #task-panels, an item of the panel strip.
      accessibility={{ container: document.body }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <LayoutDragItemContext value={drag?.item ?? null}>{children}</LayoutDragItemContext>
      {drag &&
        preview &&
        drag.hit &&
        createPortal(<DropIndicator preview={preview} hit={drag.hit} />, document.body)}
      {createPortal(
        <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
          {drag ? (
            <DragChip
              layout={layout}
              item={drag.item}
              merging={preview?.type === 'merge' || preview?.type === 'mark'}
            />
          ) : null}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  )
}

/** The outline of where a drop lands: half the group for a split, all of it for a merge, a bar in a strip. */
function DropIndicator({ preview, hit }: { preview: DropPreview; hit: Hit }): React.JSX.Element {
  const r = hit.rect
  let box: Box
  if (preview.type === 'mark') {
    box = { left: (hit.markX ?? r.left) - 1, top: r.top + 4, width: 2, height: r.height - 4 }
  } else if (preview.type === 'merge') {
    box = r
  } else {
    const w = r.width * 0.45
    const h = r.height * 0.45
    box =
      preview.zone === 'left'
        ? { ...r, width: w }
        : preview.zone === 'right'
          ? { ...r, left: r.left + r.width - w, width: w }
          : preview.zone === 'before'
            ? { ...r, height: h }
            : { ...r, top: r.top + r.height - h, height: h }
  }
  return (
    <div
      aria-hidden
      data-testid="layout-drop-indicator"
      data-drop={preview.type === 'split' ? preview.zone : preview.type}
      data-drop-slot={preview.slotId}
      className={
        preview.type === 'mark'
          ? 'fixed z-[60] pointer-events-none rounded-full bg-primary shadow-sm'
          : 'fixed z-[60] pointer-events-none rounded-lg border-2 border-primary bg-primary/15 grid place-items-center text-sm font-semibold text-foreground'
      }
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      {preview.type === 'merge' ? 'Merge as tab' : null}
    </div>
  )
}

/** The chip under the pointer: the dragged panel's icon and name (+N for a group's other tabs). */
function DragChip({
  layout,
  item,
  merging
}: {
  layout: TaskLayout
  item: DragItem
  merging: boolean
}): React.JSX.Element | null {
  const { web, settings } = useTaskPageContext()
  let instanceId: string | null = null
  let more = 0
  if (item.type === 'tab') instanceId = item.instanceId
  else {
    const loc = findSlot(layout, item.slotId)
    const slot = loc ? layout.columns[loc.columnIndex].slots[loc.slotIndex] : null
    instanceId = slot?.activeInstanceId ?? null
    more = slot ? slot.tabs.filter((t) => !t.hidden).length - 1 : 0
  }
  const instance = instanceId ? layout.instances[instanceId] : undefined
  if (!instance) return null
  const { label, icon: Icon } = panelTabMeta(instance, web.enabledWebPanels, settings.artifacts)
  return (
    <div
      data-testid="layout-drag-chip"
      className={
        merging
          ? 'inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg -rotate-2'
          : 'inline-flex items-center gap-1.5 rounded-md border border-primary bg-surface-3 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg -rotate-2'
      }
    >
      <Icon className="size-3.5" />
      {label}
      {more > 0 && <span className="text-muted-foreground">+{more}</span>}
    </div>
  )
}
