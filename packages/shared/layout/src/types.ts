// Layout framework — the tree model (pure data; no React, no DOM).
//
// A layout is a recursive tree of `split` nodes (rows/cols, children sized by
// `fractions`) and `pane` nodes (a cell holding 1+ tabbed `tiles`). A tile is
// rendered either as `dom` (React content) or `native` (an anchor whose rect is
// published to a NativeSurfaceHost). The tree is the single source of truth and
// serializes to JSON for free (no functions live in it — overlays do, and they
// are held separately in the store).
import type { ReactNode } from 'react'

export type TileType = 'terminal' | 'browser' | 'editor' | 'git' | 'settings' | 'artifacts'
export type RenderKind = 'dom' | 'native'
export type SplitDirection = 'row' | 'col'
/** Which dimension a split distributes along, and which `Size`/`Rect` field it maps to. */
export type Axis = 'w' | 'h'

export interface Size {
  w: number
  h: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Tile {
  id: string
  type: TileType
  title: string
  renderKind: RenderKind
}

export interface PaneNode {
  kind: 'pane'
  id: string
  tiles: Tile[]
  activeTileId: string
  /** Minimum content size in CSS px; used to clamp resize. */
  min: Size
}

export interface SplitNode {
  kind: 'split'
  id: string
  direction: SplitDirection
  children: LayoutNode[]
  /** Parallel to `children`, normalized to sum 1. */
  fractions: number[]
}

export type LayoutNode = SplitNode | PaneNode

export interface LayoutTree {
  root: LayoutNode | null
}

export type OverlayKind = 'dialog' | 'menu' | 'popup'

/** Lives in the store (NOT the tree) — holds a render fn, never persisted. */
export interface Overlay {
  id: string
  kind: OverlayKind
  render: () => ReactNode
  /** For menu/popup positioning (viewport px). */
  anchorRect?: Rect
}

/** Width of a divider between two split children, in CSS px. */
export const DIVIDER_PX = 6

/** Default minimum pane content size in CSS px. */
export const DEFAULT_MIN: Size = { w: 200, h: 120 }

export function isSplit(node: LayoutNode): node is SplitNode {
  return node.kind === 'split'
}

export function isPane(node: LayoutNode): node is PaneNode {
  return node.kind === 'pane'
}

let _idCounter = 0

/** Stable unique id. Uses crypto.randomUUID when available, else a counter (tests/jsdom). */
export function newId(prefix = 'node'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`
  }
  _idCounter += 1
  return `${prefix}_${_idCounter}`
}
