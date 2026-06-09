// The framework is content-agnostic: the consumer supplies a map from tile type
// to the React component that renders a `dom`-kind tile's body. `native` tiles
// bypass the registry (rendered via NativeAnchor).
import type { ComponentType } from 'react'
import type { Tile, TileType } from './types'

export interface PanelProps {
  tile: Tile
}

export type PanelComponent = ComponentType<PanelProps>
export type PanelRegistry = Partial<Record<TileType, PanelComponent>>

export function resolvePanel(registry: PanelRegistry, type: TileType): PanelComponent | null {
  return registry[type] ?? null
}
