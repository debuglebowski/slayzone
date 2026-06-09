// The seam between the renderer-authoritative layout and native panes. The
// layout publishes a tile's rect (device px, viewport-relative); an impl places
// the real native surface there. v1 ships only a no-op/logging impl — the real
// one (EmbeddedTabHost-backed) lands with the native channel work.
import type { Rect } from './types'

export interface PlacedSurface {
  tileId: string
  /** Device px, viewport-relative (CSS px * devicePixelRatio). */
  rect: Rect
  devicePixelRatio: number
}

export interface NativeSurfaceHost {
  place(surface: PlacedSurface): void
  remove(tileId: string): void
}

/** Logs placements; no actual native surface. The default host for the stub. */
export function createNoopNativeHost(): NativeSurfaceHost {
  return {
    place: (s) =>
      console.debug(
        '[NativeSurfaceHost] place',
        s.tileId,
        `${Math.round(s.rect.w)}x${Math.round(s.rect.h)}@(${Math.round(s.rect.x)},${Math.round(s.rect.y)})`,
        `dpr=${s.devicePixelRatio}`
      ),
    remove: (tileId) => console.debug('[NativeSurfaceHost] remove', tileId)
  }
}
