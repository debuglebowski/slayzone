import {
  type ChromeColors,
  getThemeChromeHex,
  getThemeTerminalColors,
  type HubThemeSettings,
  type NativeTheme,
  resolveNativeTheme,
  type TerminalThemeColors,
  type Theme,
  unifiedThemes
} from '@slayzone/theme-tokens'
import { createContext, createElement, type ReactNode, useContext } from 'react'
import { useColorScheme } from 'react-native'

/**
 * The app's colours: desktop's theme presets (`@slayzone/theme-tokens`), chosen the
 * way desktop chooses them. The ONLY module of this app that names colours
 * (`pnpm lint:theme` refuses colour literals anywhere else in src/).
 *
 * - Colours: the chosen preset's chrome (`ChromeColors` keys: `background`, `card`,
 *   `mutedForeground` …) as hex, which React Native parses (the light presets are
 *   `oklch()`, which it does not).
 * - Choice (`resolveNativeTheme`, unit-tested there): signed in, the user's settings on
 *   the PRIMARY hub — the one signed in first, when the app is signed in to several
 *   (`app/_layout.tsx` says why) — (`app_theme_id`, `app_theme_split`,
 *   `app_theme_id_dark`, `app_theme_id_light`) and that hub's light/dark preference
 *   (`settings.getThemeSource`; `system` = this device's scheme), read and kept current
 *   when another client changes them by `hub-theme.tsx`. Until those load: the ones this app last read from
 *   that hub (kept per hub between launches, `theme-cache.ts`; forgotten at sign-out).
 *   Before the app knows its sessions: the ones read last (the primary hub's). Signed
 *   out, or nothing kept: `slay` in the device's scheme. A preset without a light
 *   variant uses its dark one.
 */

export type { ChromeColors, TerminalThemeColors }

// Every preset converted once, at import: a colour the converter cannot read fails at
// startup, never mid-render, and every later lookup is a cache hit.
for (const t of unifiedThemes) {
  getThemeChromeHex(t.id, 'dark')
  getThemeChromeHex(t.id, 'light')
}

/** The signed-in user's theme settings (live, else kept); null = none (signed out). */
const HubThemeContext = createContext<HubThemeSettings | null>(null)

function useNativeTheme(): NativeTheme {
  return resolveNativeTheme(useContext(HubThemeContext), useColorScheme())
}

/** The chrome colours to paint with, as hex. The same object while the choice holds. */
export function useTheme(): ChromeColors {
  return useNativeTheme().colors
}

/**
 * The terminal's colours: the painted preset's terminal palette in the painted
 * variant — desktop's terminal (`getThemeTerminalColors(themeId, variant)`). The same
 * object while the choice holds.
 */
export function useTerminalColors(): TerminalThemeColors {
  const { themeId, variant } = useNativeTheme()
  return getThemeTerminalColors(themeId, variant)
}

/** Dark or light — for what follows the theme outside the palette (status bar). */
export function useThemeVariant(): Theme {
  return useNativeTheme().variant
}

/**
 * Paints its subtree in theme settings the app already holds (null = the defaults),
 * without reading a hub: the first paint, before the app knows its sessions, uses the
 * ones read last (`hubThemeCache.loadLast()`); `HubThemeProvider` (`hub-theme.tsx`)
 * passes the primary hub's.
 */
export function KeptThemeProvider({
  settings,
  children
}: {
  settings: HubThemeSettings | null
  children: ReactNode
}) {
  return createElement(HubThemeContext.Provider, { value: settings }, children)
}
