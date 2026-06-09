// @slayzone/layout — renderer-authoritative layout framework.
// Public API barrel. (verbatimModuleSyntax: types via `export type`.)

// Model
export type {
  TileType,
  RenderKind,
  SplitDirection,
  Axis,
  Size,
  Rect,
  Tile,
  PaneNode,
  SplitNode,
  LayoutNode,
  LayoutTree,
  OverlayKind,
  Overlay
} from './types'
export { DIVIDER_PX, DEFAULT_MIN, isSplit, isPane, newId } from './types'

// Geometry + resize (pure)
export type { DividerRect, ResolvedLayout } from './geometry'
export { resolveTree, subtreeMin, allocate, normalizeFractions, axisOf } from './geometry'
export { applySplitResize, resetSplitFractions } from './resize'

// Tree operations + builders
export type { PaneEdge } from './tree-ops'
export {
  makePane,
  makeSplit,
  findNode,
  findTile,
  findPaneOfTile,
  collectTileTypes,
  insertTile,
  removeTile,
  moveTileBetweenPanes,
  splitPane,
  replaceFractions,
  setActiveTile
} from './tree-ops'

// Persistence
export { serialize, deserialize, loadTree, saveTree } from './persistence'

// Store + selector hooks
export type { LayoutStore } from './store'
export {
  useLayoutStore,
  useLayoutTree,
  useOverlays,
  useFocusedNodeId,
  useDraggingSplitId,
  useNativeTilesVisible,
  getLayoutStore
} from './store'

// Occlusion policy (pure)
export type { OcclusionPolicy, OcclusionInputs, ResizeStrategy } from './occlusion'
export { DEFAULT_OCCLUSION_POLICY, nativeTileVisible } from './occlusion'

// Theming tokens
export { COLORS } from './colors'

// Panel registry
export type { PanelProps, PanelComponent, PanelRegistry } from './registry'
export { resolvePanel } from './registry'

// Native surface seam
export type { NativeSurfaceHost, PlacedSurface } from './NativeSurfaceHost'
export { createNoopNativeHost } from './NativeSurfaceHost'

// React components
export { LayoutRoot } from './LayoutRoot'
export { OverlayLayer } from './OverlayLayer'
export { SplitDivider } from './SplitDivider'
export { NativeAnchor } from './NativeAnchor'

// Drag-rearrange (P5)
export type { DropZone } from './dnd'
export { LayoutDndContext, TileDragHandle, PaneDropZones } from './dnd'
