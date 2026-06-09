// The framework is content-agnostic: the consumer supplies a map from tile type
// to the React component that renders a tile's body.
//
// `dom` tiles get just `{ tile }`. `native` tiles get `{ tile, anchor }` — the
// anchor is the framework-managed element whose rect is published to the
// NativeSurfaceHost; the panel component decides where it sits (e.g. below a
// URL bar). A native tile with no registry entry renders the bare anchor.
import type { ComponentType, ReactNode } from 'react'
import type { Tile, TileType } from './types'

export interface PanelProps {
  tile: Tile
  /** For native tiles: the rect-published anchor element to place in the body. */
  anchor?: ReactNode
}

export type PanelComponent = ComponentType<PanelProps>
export type PanelRegistry = Partial<Record<TileType, PanelComponent>>

export function resolvePanel(registry: PanelRegistry, type: TileType): PanelComponent | null {
  return registry[type] ?? null
}
