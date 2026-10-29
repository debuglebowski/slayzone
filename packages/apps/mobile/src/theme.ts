import {
  APP_THEME_SETTING_KEYS,
  type ChromeColors,
  getThemeChromeHex,
  type HubThemeSettings,
  LEGACY_THEME_SETTING_KEYS,
  type NativeTheme,
  resolveNativeTheme,
  type Theme,
  unifiedThemes
} from '@slayzone/theme-tokens'
import { useSubscription } from '@slayzone/transport/client'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, createElement, type ReactNode, useContext, useMemo } from 'react'
import { useColorScheme } from 'react-native'
import { useTRPC } from './trpc'

/**
 * The app's colours: desktop's theme presets (`@slayzone/theme-tokens`), chosen the
 * way desktop chooses them. The ONLY module of this app that names colours
 * (`pnpm lint:theme` refuses colour literals anywhere else in src/).
 *
 * - Colours: the chosen preset's chrome (`ChromeColors` keys: `background`, `card`,
 *   `mutedForeground` …) as hex, which React Native parses (the light presets are
 *   `oklch()`, which it does not).
 * - Choice (`resolveNativeTheme`, unit-tested there): signed in, the user's hub
 *   settings (`app_theme_id`, `app_theme_split`, `app_theme_id_dark`,
 *   `app_theme_id_light`) and the hub's light/dark preference (`settings.getThemeSource`;
 *   `system` = this device's scheme), kept current when another client changes them.
 *   Signed out, or until those load: `slay` in the device's scheme. A preset without
 *   a light variant uses its dark one.
 */

export type { ChromeColors }

// Every preset converted once, at import: a colour the converter cannot read fails at
// startup, never mid-render, and every later lookup is a cache hit.
for (const t of unifiedThemes) {
  getThemeChromeHex(t.id, 'dark')
  getThemeChromeHex(t.id, 'light')
}

/** The signed-in user's theme settings on the hub; null = none (signed out, or loading). */
const HubThemeContext = createContext<HubThemeSettings | null>(null)

function useNativeTheme(): NativeTheme {
  return resolveNativeTheme(useContext(HubThemeContext), useColorScheme())
}

/** The chrome colours to paint with, as hex. The same object while the choice holds. */
export function useTheme(): ChromeColors {
  return useNativeTheme().colors
}

/** Dark or light — for what follows the theme outside the palette (status bar). */
export function useThemeVariant(): Theme {
  return useNativeTheme().variant
}

/** The hub settings holding the choice, in `StoredAppTheme` order (legacy last). */
const SETTING_KEYS = [
  APP_THEME_SETTING_KEYS.themeId,
  APP_THEME_SETTING_KEYS.split,
  APP_THEME_SETTING_KEYS.themeIdDark,
  APP_THEME_SETTING_KEYS.themeIdLight,
  ...LEGACY_THEME_SETTING_KEYS
] as const

/**
 * Paints its subtree in the signed-in user's theme. Must sit inside `HubScope` (it
 * reads that hub over tRPC); everything outside it keeps the defaults.
 */
export function HubThemeProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const preference = useQuery(trpc.settings.getThemeSource.queryOptions())
  const stored = useQueries({
    queries: SETTING_KEYS.map((key) => trpc.settings.get.queryOptions({ key }))
  })

  // Another client changed the theme (a written setting key; null = any) or the
  // light/dark preference: re-read just that.
  useSubscription(
    trpc.notify.onSettingsChanged.subscriptionOptions(undefined, {
      onData: (event) => {
        for (const key of SETTING_KEYS) {
          if (event.keys && !event.keys.includes(key)) continue
          void queryClient.invalidateQueries(trpc.settings.get.queryFilter({ key }))
        }
      }
    })
  )
  useSubscription(
    trpc.settings.onThemeChanged.subscriptionOptions(undefined, {
      onData: () => void queryClient.invalidateQueries(trpc.settings.getThemeSource.queryFilter())
    })
  )

  // Until every setting has loaded the defaults stay (no half-applied choice); a
  // preference the hub could not answer is null (= follow the device).
  const ready = !preference.isPending && stored.every((q) => q.isSuccess)
  const source = preference.data ?? null
  const [themeId, split, themeIdDark, themeIdLight, legacy, olderLegacy] = stored.map(
    (q) => q.data ?? null
  )
  // A new context value only when the settings change, not on every refetch.
  const settings = useMemo<HubThemeSettings | null>(
    () =>
      ready
        ? {
            preference: source,
            stored: {
              themeId,
              split,
              themeIdDark,
              themeIdLight,
              legacyThemeId: legacy ?? olderLegacy
            }
          }
        : null,
    [ready, source, themeId, split, themeIdDark, themeIdLight, legacy, olderLegacy]
  )
  return createElement(HubThemeContext.Provider, { value: settings }, children)
}
