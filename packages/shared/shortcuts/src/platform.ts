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
 * Whether the platform's primary modifier (`mod`) is held: Cmd on macOS, Ctrl elsewhere.
 * For raw mouse/keyboard handlers that can't go through `matchesShortcut` — gating on
 * `metaKey` alone leaves them dead off macOS, where metaKey is the Win/Super key. Off
 * macOS it also rejects Ctrl while Win/Super is held, mirroring `matchesShortcut`.
 */
export function isPrimaryModifier(
  e: { metaKey: boolean; ctrlKey: boolean },
  platform: Platform = detectPlatform()
): boolean {
  return platform === 'mac' ? e.metaKey : e.ctrlKey && !e.metaKey
}
