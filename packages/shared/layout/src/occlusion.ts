// Centralized native-tile visibility policy (pure — unit-tested).
//
// A native surface paints ABOVE the web-layout plane, so the engine must hide
// it whenever web content that should cover it is showing. Policy inputs:
//
// - dialog overlays: full-bleed scrim → hide ALL native tiles while one is
//   open. (Menus/popups are rect-anchored; per-rect intersection is a later
//   refinement. When the native overlay plane lands (roadmap P4), dialogs STOP
//   hiding native tiles — flip `dialogsHideNative` off.)
// - divider drag: under the 'hide-during-drag' resize strategy, native tiles
//   hide while a split divider is dragging (electron's proven `!isResizing`
//   gate) and reveal at the final rect on release. Under 'live' they keep
//   tracking every frame.
import type { Overlay } from './types'

export type ResizeStrategy = 'live' | 'hide-during-drag'

export interface OcclusionPolicy {
  /** Roadmap P4 flips this to false once dialogs render on the native overlay plane. */
  dialogsHideNative: boolean
  resizeStrategy: ResizeStrategy
}

export const DEFAULT_OCCLUSION_POLICY: OcclusionPolicy = {
  dialogsHideNative: true,
  resizeStrategy: 'live'
}

export interface OcclusionInputs {
  overlays: Overlay[]
  draggingSplitId: string | null
}

/** Should a native tile's surface be visible right now? */
export function nativeTileVisible(policy: OcclusionPolicy, inputs: OcclusionInputs): boolean {
  if (policy.dialogsHideNative && inputs.overlays.some((o) => o.kind === 'dialog')) return false
  if (policy.resizeStrategy === 'hide-during-drag' && inputs.draggingSplitId !== null) return false
  return true
}
