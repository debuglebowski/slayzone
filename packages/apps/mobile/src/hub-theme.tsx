/**
 * The user's theme settings, read from a hub (`theme.ts` turns them into colours):
 * `HubThemeReader` reads and follows them, `HubThemeProvider` paints the app in the
 * primary hub's — the kept ones (`theme-cache.ts`) until the hub answers.
 */
import {
  APP_THEME_SETTING_KEYS,
  type HubThemeSettings,
  LEGACY_THEME_SETTING_KEYS,
  pickHubThemeSettings
} from '@slayzone/theme-tokens'
import { HubScope, useSubscription } from '@slayzone/transport/client'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { KeptThemeProvider } from './theme'
import { hubThemeCache } from './theme-cache'
import { useTRPC } from './trpc'

/** The hub settings holding the choice, in `StoredAppTheme` order (legacy last). */
const SETTING_KEYS = [
  APP_THEME_SETTING_KEYS.themeId,
  APP_THEME_SETTING_KEYS.split,
  APP_THEME_SETTING_KEYS.themeIdDark,
  APP_THEME_SETTING_KEYS.themeIdLight,
  ...LEGACY_THEME_SETTING_KEYS
] as const

/**
 * Reads the user's theme settings from a hub and reports them (`onSettings`) once all
 * have loaded and whenever they change — another client changing the theme included.
 * Must sit inside that hub's `HubScope`; renders nothing (`HubThemeProvider` places
 * it beside the screens, not around them).
 */
export function HubThemeReader({
  onSettings
}: {
  onSettings: (settings: HubThemeSettings) => void
}): null {
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

  // Until every setting has loaded, nothing is reported: no half-applied choice. A
  // preference the hub could not answer is null (= follow the device).
  const ready = !preference.isPending && stored.every((q) => q.isSuccess)
  const source = preference.data ?? null
  const [themeId, split, themeIdDark, themeIdLight, legacy, olderLegacy] = stored.map(
    (q) => q.data ?? null
  )
  // A new value only when the settings change, not on every refetch.
  const live = useMemo<HubThemeSettings | null>(
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

  useEffect(() => {
    if (live) onSettings(live)
  }, [live, onSettings])
  return null
}

/**
 * Paints its subtree in the theme of hub `hubId` (null = no hub: the defaults). The
 * settings are read by a `HubThemeReader` in that hub's `HubScope` BESIDE the subtree,
 * so the subtree is not inside any hub's scope. Until the hub's settings load it paints
 * what the app kept from that hub at the last launch (`theme-cache.ts`); once they load
 * it keeps them for the next one.
 */
export function HubThemeProvider({
  hubId,
  children
}: {
  hubId: string | null
  children: ReactNode
}) {
  // Synchronous file read, once per hub: the first frame already paints the kept theme.
  const cached = useMemo(() => (hubId ? hubThemeCache.load(hubId) : null), [hubId])
  const [live, setLive] = useState<{ hubId: string; settings: HubThemeSettings } | null>(null)

  const onSettings = useCallback(
    (settings: HubThemeSettings) => {
      if (!hubId) return
      // Keep what the hub said for the next launch's first paint.
      hubThemeCache.save(hubId, settings)
      setLive({ hubId, settings })
    },
    [hubId]
  )

  // Settings read from a previous primary hub never paint this one.
  const settings = live && live.hubId === hubId ? live.settings : null
  return (
    <>
      {hubId ? (
        <HubScope key={hubId} hubId={hubId}>
          <HubThemeReader onSettings={onSettings} />
        </HubScope>
      ) : null}
      <KeptThemeProvider settings={pickHubThemeSettings(settings, cached)}>
        {children}
      </KeptThemeProvider>
    </>
  )
}
