import type { Theme } from './types'

/**
 * Which preset and which variant (dark/light) a client paints, from the user's
 * stored choice. Pure, so desktop (`@slayzone/settings` ThemeProvider + its
 * first-paint cache) and the mobile app resolve the choice the same way.
 */

/** The preset a user who never chose one gets. */
export const DEFAULT_THEME_ID = 'slay'

/** Maps old variant-specific IDs to unified family IDs */
export const LEGACY_ID_MAP: Record<string, string> = {
  'slay-light': 'slay',
  'slay-special-light': 'slay-special',
  'default-light': 'default-dark',
  'catppuccin-mocha': 'catppuccin',
  'catppuccin-latte': 'catppuccin',
  'solarized-dark': 'solarized',
  'solarized-light': 'solarized',
  'tokyo-night-light': 'tokyo-night',
  'rose-pine-dawn': 'rose-pine'
}

export function migrateThemeId(id: string): string {
  return LEGACY_ID_MAP[id] ?? id
}

/**
 * Hub settings (`settings.get` keys) that hold the app-theme choice. Per user on a
 * hub that requires login (they are `user`-scoped, `@slayzone/settings-core`).
 */
export const APP_THEME_SETTING_KEYS = {
  /** The one preset, when split is off. */
  themeId: 'app_theme_id',
  /** `'1'` = a separate preset for dark and for light. */
  split: 'app_theme_split',
  themeIdDark: 'app_theme_id_dark',
  themeIdLight: 'app_theme_id_light'
} as const

/**
 * Pre-unified-theme keys, read in this order only when `app_theme_id` was never
 * written (desktop then writes the migrated id back to `app_theme_id`).
 */
export const LEGACY_THEME_SETTING_KEYS = ['content_theme_dark', 'terminal_theme_dark'] as const

/** The stored values, `null` = unset (what `settings.get` answers). */
export interface StoredAppTheme {
  themeId: string | null
  split: string | null
  themeIdDark: string | null
  themeIdLight: string | null
  /** The first set {@link LEGACY_THEME_SETTING_KEYS} value; consulted only when `themeId` is empty. */
  legacyThemeId?: string | null
}

/** The user's app-theme choice, ids migrated. */
export interface AppThemeSelection {
  singleThemeId: string
  split: boolean
  themeIdDark: string
  themeIdLight: string
}

export function resolveAppThemeSelection(stored: StoredAppTheme): AppThemeSelection {
  const singleThemeId = migrateThemeId(
    stored.themeId ? stored.themeId : (stored.legacyThemeId ?? DEFAULT_THEME_ID)
  )
  return {
    singleThemeId,
    split: stored.split === '1',
    themeIdDark: migrateThemeId(stored.themeIdDark ?? singleThemeId),
    themeIdLight: migrateThemeId(stored.themeIdLight ?? singleThemeId)
  }
}

/** The preset the app chrome uses in this variant (split picks one per variant). */
export function selectChromeThemeId(selection: AppThemeSelection, variant: Theme): string {
  if (!selection.split) return selection.singleThemeId
  return variant === 'dark' ? selection.themeIdDark : selection.themeIdLight
}

/**
 * Dark or light from the user's preference: an explicit one wins, `system` asks the
 * OS (`system` is called only then), and anything else (not loaded, unknown) gets
 * `fallback`.
 */
export function resolveThemeVariant(
  preference: string | null | undefined,
  system: () => Theme,
  fallback: Theme
): Theme {
  if (preference === 'light' || preference === 'dark') return preference
  if (preference === 'system') return system()
  return fallback
}
