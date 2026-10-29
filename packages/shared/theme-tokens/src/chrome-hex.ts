import { toHexColors } from './color'
import { getThemeChrome } from './themes'
import type { ChromeColors, Theme } from './types'

/** Converted palettes, keyed by the preset's own chrome object (fallbacks share one). */
const cache = new WeakMap<ChromeColors, ChromeColors>()

/**
 * A preset variant's chrome colours as `#rrggbb[aa]` — what React Native can parse
 * (`oklch()` it cannot). Same keys and fallbacks as `getThemeChrome`; desktop keeps
 * painting the original strings. Converted once per palette: repeated calls return
 * the same object.
 */
export function getThemeChromeHex(id: string, variant: Theme): ChromeColors {
  const chrome = getThemeChrome(id, variant)
  let hex = cache.get(chrome)
  if (!hex) {
    hex = toHexColors(chrome)
    cache.set(chrome, hex)
  }
  return hex
}
