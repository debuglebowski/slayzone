// Tile drag-rearrange (P5). House dnd-kit patterns: PointerSensor with a 6px
// activation threshold (click still works), pointerWithin collision.
//
// Draggables: a pane's title (single tile) and each tab button — id `tile:<id>`.
// Droppables (only rendered mid-drag): per pane, a center zone (stack as tab)
// and four edge zones (split) — id `drop:<paneId>:<zone>`.
// Native tiles hide while a drag is active (occlusion policy) so the DOM
// preview + drop highlights paint above everything.
import type { ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import type { Tile } from './types'
import type { PaneEdge } from './tree-ops'
import { findPaneOfTile, findTile } from './tree-ops'
import { getLayoutStore, useLayoutStore } from './store'
import { COLORS } from './colors'

export type DropZone = PaneEdge | 'center'

const tileDragId = (tileId: string): string => `tile:${tileId}`
const dropId = (paneId: string, zone: DropZone): string => `drop:${paneId}:${zone}`

function parseDrop(id: string): { paneId: string; zone: DropZone } | null {
  const m = /^drop:(.+):(north|south|east|west|center)$/.exec(id)
  return m ? { paneId: m[1], zone: m[2] as DropZone } : null
}

function parseTile(id: string): string | null {
  return id.startsWith('tile:') ? id.slice('tile:'.length) : null
}

export function LayoutDndContext({ children }: { children: ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const draggingTileId = useLayoutStore((s) => s.draggingTileId)
  const draggingTile = useLayoutStore((s) =>
    s.draggingTileId ? findTile(s.tree.root, s.draggingTileId) : null
  )

  const onDragStart = (e: DragStartEvent): void => {
    const tileId = parseTile(String(e.active.id))
    if (tileId) getLayoutStore().setDraggingTile(tileId)
  }

  const onDragEnd = (e: DragEndEvent): void => {
    const store = getLayoutStore()
    const tileId = parseTile(String(e.active.id))
    store.setDraggingTile(null)
    if (!tileId || !e.over) return
    const drop = parseDrop(String(e.over.id))
    if (!drop) return
    const tile = findTile(store.tree.root, tileId)
    if (!tile) return
    if (drop.zone === 'center') {
      const sourcePane = findPaneOfTile(store.tree.root, tileId)
      if (sourcePane?.id === drop.paneId) return // dropped on its own pane
      store.moveTile(tileId, drop.paneId)
    } else {
      store.splitPaneAt(drop.paneId, drop.zone, tile)
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => getLayoutStore().setDraggingTile(null)}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {draggingTileId && draggingTile ? <DragChip title={draggingTile.title} /> : null}
      </DragOverlay>
    </DndContext>
  )
}

function DragChip({ title }: { title: string }) {
  return (
    <div
      style={{
        padding: '6px 12px',
        borderRadius: 7,
        background: COLORS.activeBg,
        border: `1px solid ${COLORS.accent}`,
        color: COLORS.text,
        font: '12px ui-sans-serif, system-ui, sans-serif',
        fontWeight: 600,
        boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
        cursor: 'grabbing'
      }}
    >
      {title}
    </div>
  )
}

/** Drag handle wrapper — makes its children initiate a tile drag. */
export function TileDragHandle({ tileId, children }: { tileId: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: tileDragId(tileId) })
  return (
    <span ref={setNodeRef} {...attributes} {...listeners} style={{ display: 'inline-flex', minWidth: 0 }}>
      {children}
    </span>
  )
}

const EDGE_FRACTION = 0.25

function zoneRect(zone: DropZone): React.CSSProperties {
  switch (zone) {
    case 'north':
      return { left: 0, right: 0, top: 0, height: `${EDGE_FRACTION * 100}%` }
    case 'south':
      return { left: 0, right: 0, bottom: 0, height: `${EDGE_FRACTION * 100}%` }
    case 'west':
      return { left: 0, top: `${EDGE_FRACTION * 100}%`, bottom: `${EDGE_FRACTION * 100}%`, width: `${EDGE_FRACTION * 100}%` }
    case 'east':
      return { right: 0, top: `${EDGE_FRACTION * 100}%`, bottom: `${EDGE_FRACTION * 100}%`, width: `${EDGE_FRACTION * 100}%` }
    case 'center':
      return {
        left: `${EDGE_FRACTION * 100}%`,
        right: `${EDGE_FRACTION * 100}%`,
        top: `${EDGE_FRACTION * 100}%`,
        bottom: `${EDGE_FRACTION * 100}%`
      }
  }
}

function PaneDropZone({ paneId, zone }: { paneId: string; zone: DropZone }) {
  const { isOver, setNodeRef } = useDroppable({ id: dropId(paneId, zone) })
  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'absolute',
        ...zoneRect(zone),
        zIndex: 5,
        borderRadius: 6,
        background: isOver ? 'rgba(124, 124, 240, 0.25)' : 'transparent',
        border: isOver ? `1px solid ${COLORS.accent}` : '1px solid transparent',
        transition: 'background 80ms'
      }}
    />
  )
}

/** Overlayed on a pane while a tile drag is active. */
export function PaneDropZones({ paneId }: { paneId: string }) {
  const zones: DropZone[] = ['center', 'north', 'south', 'east', 'west']
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}>
        {zones.map((z) => (
          <PaneDropZone key={z} paneId={paneId} zone={z} />
        ))}
      </div>
    </div>
  )
}
