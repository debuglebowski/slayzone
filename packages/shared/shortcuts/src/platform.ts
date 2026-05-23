export type Platform = 'mac' | 'other'

let cached: Platform | null = null

export function detectPlatform(): Platform {
  if (cached) return cached
  if (typeof process !== 'undefined' && process.platform) {
    cached = process.platform === 'darwin' ? 'mac' : 'other'
  } else if (typeof navigator !== 'undefined' && navigator.userAgent) {
    cached = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? 'mac' : 'other'
  } else {
    cached = 'other'
  }
  return cached
}

/**
 * Whether the platform's primary shortcut modifier is pressed for an event.
 * Maps to Cmd (metaKey) on macOS and Ctrl (ctrlKey) everywhere else — the same
 * `mod` semantics used by the shortcut registry, but for raw mouse/keyboard
 * handlers that can't go through `matchesShortcut`. On Windows/Linux metaKey is
 * the Super/Win key, so handlers must not gate on it — and, mirroring the
 * registry's non-mac rejection of meta, must not fire while it is also held.
 */
export function isPrimaryModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return detectPlatform() === 'mac' ? e.metaKey : e.ctrlKey && !e.metaKey
}
