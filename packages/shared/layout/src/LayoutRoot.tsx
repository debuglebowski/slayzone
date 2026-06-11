// The render walk: measure the container, resolve the tree to rectangles, then
// paint each pane (web-layout plane), the dividers, and the overlay plane on top.
// Native-kind tiles render a NativeAnchor (their pixels come from the native
// plane). Geometry math lives in geometry.ts — this file only positions things.
// Tile drag-rearrange (move/stack/split) is wired via dnd.tsx.
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LayoutNode, PaneNode, Rect, SplitNode, Tile } from './types'
import { DIVIDER_PX, isPane, isSplit } from './types'
import { axisOf, resolveTree, subtreeMin } from './geometry'
import { findNode } from './tree-ops'
import { getLayoutStore, useLayoutStore, useLayoutTree } from './store'
import type { NativeSurfaceHost } from './NativeSurfaceHost'
import type { PanelRegistry } from './registry'
import { resolvePanel } from './registry'
import { SplitDivider } from './SplitDivider'
import { OverlayLayer } from './OverlayLayer'
import { NativeAnchor } from './NativeAnchor'
import { LayoutDndContext, PaneDropZones, TileDragHandle } from './dnd'
import { COLORS } from './colors'

interface LayoutRootProps {
  registry: PanelRegistry
  host: NativeSurfaceHost
}

interface Size {
  w: number
  h: number
}

// Measure the container; seed a sensible size so the very first (synchronous)
// render has non-zero geometry — important for the headless screenshot probe.
function useElementSize(): [(el: HTMLDivElement | null) => void, Size] {
  const elRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<Size>(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1200,
    h: typeof window !== 'undefined' ? window.innerHeight : 800
  }))
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const setRef = (el: HTMLDivElement | null): void => {
    elRef.current = el
  }
  return [setRef, size]
}

function findSplit(root: LayoutNode | null, id: string): SplitNode | null {
  const node = findNode(root, id)
  return node && isSplit(node) ? node : null
}

function collectPanes(root: LayoutNode): PaneNode[] {
  const out: PaneNode[] = []
  const walk = (n: LayoutNode): void => {
    if (isPane(n)) out.push(n)
    else n.children.forEach(walk)
  }
  walk(root)
  return out
}

export function LayoutRoot({ registry, host }: LayoutRootProps) {
  const tree = useLayoutTree()
  const [setRef, size] = useElementSize()
  const resolved = useMemo(
    () => resolveTree(tree.root, { x: 0, y: 0, w: size.w, h: size.h }),
    [tree.root, size.w, size.h]
  )

  return (
    <LayoutDndContext>
      <div ref={setRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        {tree.root ? (
          <>
            {collectPanes(tree.root).map((pane) => {
              const rect = resolved.rects.get(pane.id)
              return rect ? (
                <PaneView key={pane.id} pane={pane} rect={rect} registry={registry} host={host} />
              ) : null
            })}
            {resolved.dividers.map((d) => {
              const split = findSplit(tree.root, d.splitId)
              const splitRect = resolved.rects.get(d.splitId)
              if (!split || !splitRect) return null
              const axis = axisOf(d.direction)
              const total = axis === 'w' ? splitRect.w : splitRect.h
              const totalContentPx = Math.max(
                0,
                total - DIVIDER_PX * Math.max(0, split.children.length - 1)
              )
              const childMinsPx = split.children.map((c) => subtreeMin(c, axis))
              return (
                <SplitDivider
                  key={`${d.splitId}:${d.index}`}
                  splitId={d.splitId}
                  index={d.index}
                  rect={d.rect}
                  direction={d.direction}
                  childMinsPx={childMinsPx}
                  totalContentPx={totalContentPx}
                  getFractions={() => findSplit(getLayoutStore().tree.root, d.splitId)?.fractions ?? []}
                  onResize={(fractions) => getLayoutStore().resizeSplit(d.splitId, fractions)}
                  onDragChange={(id) => getLayoutStore().setDraggingSplit(id)}
                />
              )
            })}
          </>
        ) : (
          <EmptyHint />
        )}
        <OverlayLayer />
      </div>
    </LayoutDndContext>
  )
}

function PaneView(props: { pane: PaneNode; rect: Rect; registry: PanelRegistry; host: NativeSurfaceHost }) {
  const { pane, rect, registry, host } = props
  const active = pane.tiles.find((t) => t.id === pane.activeTileId) ?? pane.tiles[0]
  const tileDragActive = useLayoutStore((s) => s.draggingTileId !== null)
  return (
    <section
      data-pane-id={pane.id}
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        background: COLORS.panelBg,
        overflow: 'hidden'
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          minHeight: 33,
          padding: '0 4px',
          borderBottom: `1px solid ${COLORS.border}`
        }}
      >
        {pane.tiles.length > 1 ? (
          pane.tiles.map((t) => (
            <TabButton key={t.id} tile={t} active={t.id === active?.id} paneId={pane.id} />
          ))
        ) : active ? (
          <TileDragHandle tileId={active.id}>
            <span style={{ padding: '8px', fontSize: 12, fontWeight: 600, color: '#cfcfd4', cursor: 'grab' }}>
              {active.title}
            </span>
          </TileDragHandle>
        ) : null}
      </header>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {/* Render ALL tiles (inactive ones display:none) so a tab's native view
            persists across tab switches — only the active tab composites. */}
        {pane.tiles.map((t) => (
          <div
            key={t.id}
            style={{ position: 'absolute', inset: 0, display: t.id === active?.id ? 'block' : 'none' }}
          >
            <TileBody tile={t} registry={registry} host={host} active={t.id === active?.id} />
          </div>
        ))}
        {tileDragActive ? <PaneDropZones paneId={pane.id} /> : null}
      </div>
    </section>
  )
}

function TileBody(props: {
  tile: Tile
  registry: PanelRegistry
  host: NativeSurfaceHost
  active: boolean
}) {
  const { tile, registry, host, active } = props
  const Comp = resolvePanel(registry, tile.type)
  if (tile.renderKind === 'native') {
    const anchor = (
      <NativeAnchor tileId={tile.id} host={host} label={`${tile.title} (native pane)`} active={active} />
    )
    if (Comp) return <Comp tile={tile} anchor={anchor} />
    return anchor
  }
  if (Comp) return <Comp tile={tile} />
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: COLORS.faint,
        fontSize: 12
      }}
    >
      {tile.title} — unknown panel
    </div>
  )
}

function TabButton(props: { tile: Tile; active: boolean; paneId: string }) {
  const { tile, active, paneId } = props
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <TileDragHandle tileId={tile.id}>
        <button
          type="button"
          onClick={() => getLayoutStore().setActiveTab(paneId, tile.id)}
          style={{
            border: 'none',
            borderRadius: 6,
            padding: '6px 4px 6px 10px',
            cursor: 'pointer',
            font: '12px ui-sans-serif, system-ui, sans-serif',
            fontWeight: 600,
            background: active ? COLORS.activeBg : 'transparent',
            color: active ? COLORS.text : COLORS.muted
          }}
        >
          {tile.title}
        </button>
      </TileDragHandle>
      <button
        type="button"
        aria-label={`Close ${tile.title}`}
        onClick={() => getLayoutStore().closeTile(tile.id)}
        style={{
          border: 'none',
          borderRadius: 6,
          padding: '6px 6px',
          cursor: 'pointer',
          font: '11px ui-sans-serif, system-ui, sans-serif',
          background: 'transparent',
          color: COLORS.faint
        }}
      >
        ×
      </button>
    </span>
  )
}

function EmptyHint() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: COLORS.faint,
        fontSize: 13
      }}
    >
      No panels — toggle one above.
    </div>
  )
}
