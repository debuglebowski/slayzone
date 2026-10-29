import { getThemeChromeHex } from './chrome-hex'
import {
  resolveAppThemeSelection,
  resolveThemeVariant,
  selectChromeThemeId,
  type StoredAppTheme
} from './selection'
import { getUnifiedTheme } from './themes'
import type { ChromeColors, Theme } from './types'

/** The theme choice a client reads from its hub. */
export interface HubThemeSettings {
  /** `settings.getThemeSource`: 'light' | 'dark' | 'system'; null = the hub did not answer. */
  preference: string | null
  /** The `APP_THEME_SETTING_KEYS` (+ legacy) values from `settings.get`. */
  stored: StoredAppTheme
}

/** What a client without CSS (React Native) paints. */
export interface NativeTheme {
  /** The preset painted (after split, legacy ids; an unknown id paints `slay`). */
  themeId: string
  /**
   * The variant painted: the chosen one, except `dark` for a preset without a light
   * variant (its dark colours are painted), so what follows it (status bar text)
   * matches the colours.
   */
  variant: Theme
  /** That preset variant's chrome as hex (its dark one if it has no light). */
  colors: ChromeColors
}

const NOTHING_STORED: StoredAppTheme = {
  themeId: null,
  split: null,
  themeIdDark: null,
  themeIdLight: null
}

/**
 * Hub settings + the device's own light/dark scheme → the preset, variant and hex
 * colours to paint — desktop's resolution (same selection functions), for a client
 * that cannot read CSS colours.
 *
 * `hub` null (signed out, settings not loaded) = nothing stored: the default preset.
 * The preference follows desktop: explicit light/dark wins, `system` (and a hub that
 * did not answer) follows the device. A device scheme other than light/dark
 * (React Native's 'unspecified') counts as dark, desktop's default.
 */
export function resolveNativeTheme(
  hub: HubThemeSettings | null,
  deviceScheme: string | null | undefined
): NativeTheme {
  const device: Theme = deviceScheme === 'light' ? 'light' : 'dark'
  const variant = resolveThemeVariant(hub?.preference ?? 'system', () => device, device)
  const chosen = selectChromeThemeId(
    resolveAppThemeSelection(hub?.stored ?? NOTHING_STORED),
    variant
  )
  const theme = getUnifiedTheme(chosen)
  const painted: Theme = variant === 'light' && !theme.light ? 'dark' : variant
  return { themeId: theme.id, variant: painted, colors: getThemeChromeHex(theme.id, painted) }
}
