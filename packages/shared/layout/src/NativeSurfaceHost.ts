// The seam between the renderer-authoritative layout and native panes. The
// layout publishes a tile's rect; an impl places the real native surface there.
//
// Coordinate space: CSS px, viewport-relative. In the chromium fork the shell
// page is full-bleed at the container origin, so CSS px map 1:1 to view DIPs —
// the native side handles device scaling. `devicePixelRatio` is included for
// hosts that need physical pixels.
import type { Rect } from './types'

export interface PlacedSurface {
  tileId: string
  /** CSS px, viewport-relative. */
  rect: Rect
  devicePixelRatio: number
}

export interface NativeSurfaceHost {
  place(surface: PlacedSurface): void
  /** Occlusion/visibility — hide keeps the surface alive but unpainted. */
  setVisible(tileId: string, visible: boolean): void
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
    setVisible: (tileId, visible) => console.debug('[NativeSurfaceHost] setVisible', tileId, visible),
    remove: (tileId) => console.debug('[NativeSurfaceHost] remove', tileId)
  }
}
