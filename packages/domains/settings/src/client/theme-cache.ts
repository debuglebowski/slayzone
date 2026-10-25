import type { Theme, ThemePreference } from '@slayzone/settings/shared'

/**
 * Last-applied theme settings, kept in localStorage so the window paints in the
 * user's theme at once — before React mounts, and without waiting for the
 * settings round-trip, which at boot queues behind the multi-MB board load on
 * the same hub socket (~1s). The server values still load and win; this only
 * decides the first paint. Per-origin, so each release channel keeps its own.
 */
export interface ThemeCache {
  preference: ThemePreference
  /** Effective dark/light when last applied (used when the preference is neither). */
  effective: Theme
  singleThemeId: string
  split: boolean
  themeIdDark: string
  themeIdLight: string
  terminalOverrideThemeId: string
  editorOverrideThemeId: string
}

const KEY = 'sz:theme-cache:v1'

export function readThemeCache(): ThemeCache | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<ThemeCache>
    if (
      (c.preference !== 'light' && c.preference !== 'dark' && c.preference !== 'system') ||
      (c.effective !== 'light' && c.effective !== 'dark') ||
      typeof c.singleThemeId !== 'string' ||
      typeof c.split !== 'boolean' ||
      typeof c.themeIdDark !== 'string' ||
      typeof c.themeIdLight !== 'string' ||
      typeof c.terminalOverrideThemeId !== 'string' ||
      typeof c.editorOverrideThemeId !== 'string'
    )
      return null
    return c as ThemeCache
  } catch {
    return null
  }
}

export function writeThemeCache(c: ThemeCache): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    /* storage unavailable — first paint just falls back to the default */
  }
}

/** The OS dark/light setting (renderer-side; see ThemeContext `systemTheme`). */
export function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Effective dark/light + chrome theme id a cached setting resolves to now. */
export function resolveThemeCache(c: ThemeCache): { theme: Theme; themeId: string } {
  const theme =
    c.preference === 'light' || c.preference === 'dark'
      ? c.preference
      : c.preference === 'system'
        ? systemTheme()
        : c.effective
  const themeId = c.split ? (theme === 'dark' ? c.themeIdDark : c.themeIdLight) : c.singleThemeId
  return { theme, themeId }
}
