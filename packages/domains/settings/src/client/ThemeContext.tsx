import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from './trpc'
import type { Theme, ThemePreference } from '@slayzone/settings/shared'
import { track } from '@slayzone/telemetry/client'
import { ThemeContext, useStableCallback, type ThemeContextValue } from '@slayzone/ui'
import {
  APP_THEME_SETTING_KEYS,
  DEFAULT_THEME_ID,
  LEGACY_THEME_SETTING_KEYS,
  migrateThemeId,
  resolveAppThemeSelection,
  resolveThemeVariant,
  selectChromeThemeId
} from '@slayzone/theme-tokens'
import { applyTheme } from './apply-theme'
import { readThemeCache, resolveThemeCache, systemTheme, writeThemeCache } from './theme-cache'

// "system" is resolved in the renderer (`systemTheme`, theme-cache.ts): the
// chromium-fork sidecar has no Electron `nativeTheme`, so its server-side
// effective-theme is a constant. matchMedia reflects nativeTheme in Electron too.

// Effective dark/light from the user's preference: explicit wins, "system" maps
// to the OS, and a non-preference value falls back to the server's answer.
function resolveEffective(source: ThemePreference, serverEffective: Theme): Theme {
  return resolveThemeVariant(source, systemTheme, serverEffective)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const setThemeMutation = useMutation(trpc.settings.setTheme.mutationOptions())
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())

  // First paint uses the last-applied settings (theme-cache.ts, also applied by
  // the pre-React theme-init) so the window never flashes the default theme while
  // the settings load queues behind the board; the server values below still win.
  const [cached] = useState(readThemeCache)
  const [theme, setTheme] = useState<Theme>(() =>
    cached ? resolveThemeCache(cached).theme : 'dark'
  )
  const [preference, setPreferenceState] = useState<ThemePreference>(cached?.preference ?? 'dark')

  // Single theme (when split off)
  const [singleThemeId, setSingleThemeId] = useState(cached?.singleThemeId ?? DEFAULT_THEME_ID)

  // Split themes
  const [splitThemes, setSplitThemesState] = useState(cached?.split ?? false)
  const [themeIdDark, setThemeIdDarkState] = useState(cached?.themeIdDark ?? DEFAULT_THEME_ID)
  const [themeIdLight, setThemeIdLightState] = useState(cached?.themeIdLight ?? DEFAULT_THEME_ID)

  // Per-section overrides (empty = same as app)
  const [terminalOverrideThemeId, setTerminalOverrideThemeIdState] = useState(
    cached?.terminalOverrideThemeId ?? ''
  )
  const [editorOverrideThemeId, setEditorOverrideThemeIdState] = useState(
    cached?.editorOverrideThemeId ?? ''
  )

  // Resolved
  const themeId = selectChromeThemeId(
    { singleThemeId, split: splitThemes, themeIdDark, themeIdLight },
    theme
  )
  const terminalThemeId = terminalOverrideThemeId || themeId
  const editorThemeId = editorOverrideThemeId || themeId
  const contentVariant = theme

  useEffect(() => {
    let disposed = false
    performance.mark('sz:theme:start')

    const getSetting = (key: string): Promise<string | null> =>
      queryClient.fetchQuery(trpc.settings.get.queryOptions({ key }))

    const initialize = async () => {
      const [
        effective,
        source,
        savedThemeId,
        savedSplit,
        savedDark,
        savedLight,
        savedTermOvrId,
        savedEditorOvrId
      ] = await Promise.all([
        queryClient.fetchQuery(trpc.settings.getEffectiveTheme.queryOptions()),
        queryClient.fetchQuery(trpc.settings.getThemeSource.queryOptions()),
        getSetting(APP_THEME_SETTING_KEYS.themeId),
        getSetting(APP_THEME_SETTING_KEYS.split),
        getSetting(APP_THEME_SETTING_KEYS.themeIdDark),
        getSetting(APP_THEME_SETTING_KEYS.themeIdLight),
        getSetting('terminal_override_theme_id'),
        getSetting('editor_override_theme_id')
      ])
      if (disposed) return

      // Migrate single theme from legacy
      const [legacyKey, olderLegacyKey] = LEGACY_THEME_SETTING_KEYS
      const legacyThemeId = savedThemeId
        ? null
        : await getSetting(legacyKey).then((v) => v ?? getSetting(olderLegacyKey))
      const selection = resolveAppThemeSelection({
        themeId: savedThemeId,
        split: savedSplit,
        themeIdDark: savedDark,
        themeIdLight: savedLight,
        legacyThemeId
      })
      if (!savedThemeId) {
        setSettingMutation.mutate({
          key: APP_THEME_SETTING_KEYS.themeId,
          value: selection.singleThemeId
        })
      }

      const resolved = resolveEffective(source, effective)
      setTheme(resolved)
      setPreferenceState(source)
      setSingleThemeId(selection.singleThemeId)
      setSplitThemesState(selection.split)
      setThemeIdDarkState(selection.themeIdDark)
      setThemeIdLightState(selection.themeIdLight)
      setTerminalOverrideThemeIdState(savedTermOvrId ? migrateThemeId(savedTermOvrId) : '')
      setEditorOverrideThemeIdState(savedEditorOvrId ? migrateThemeId(savedEditorOvrId) : '')

      applyTheme(resolved, selectChromeThemeId(selection, resolved))
      performance.mark('sz:theme:end')
    }

    initialize().catch(() => {
      if (disposed) return
      setTheme('dark')
      setPreferenceState('dark')
      setSingleThemeId(DEFAULT_THEME_ID)
      applyTheme('dark', DEFAULT_THEME_ID)
      performance.mark('sz:theme:end')
    })

    return () => {
      disposed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Replaces the old preload theme listener: fires on OS dark/light toggle (when
  // source === 'system') or an explicit setTheme.
  useSubscription(
    trpc.settings.onThemeChanged.subscriptionOptions(undefined, {
      onData: (effective) => setTheme(effective)
    })
  )

  // Follow OS dark/light while the preference is "system". The fork sidecar can't
  // push OS changes (no nativeTheme), so this renderer-side listener is what makes
  // system mode track the OS there; on Electron it harmlessly mirrors the
  // onThemeChanged push.
  useEffect(() => {
    if (preference !== 'system') return
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setTheme(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [preference])

  // Re-apply chrome whenever resolved themeId or theme changes
  useEffect(() => {
    applyTheme(theme, themeId)
  }, [theme, themeId])

  // Remember what is applied, for the next window's first paint.
  useEffect(() => {
    writeThemeCache({
      preference,
      effective: theme,
      singleThemeId,
      split: splitThemes,
      themeIdDark,
      themeIdLight,
      terminalOverrideThemeId,
      editorOverrideThemeId
    })
  }, [
    preference,
    theme,
    singleThemeId,
    splitThemes,
    themeIdDark,
    themeIdLight,
    terminalOverrideThemeId,
    editorOverrideThemeId
  ])

  const setPreference = useStableCallback(async (nextPreference: ThemePreference) => {
    const serverEffective = await setThemeMutation.mutateAsync(nextPreference)
    setPreferenceState(nextPreference)
    setTheme(resolveEffective(nextPreference, serverEffective))
    track('theme_changed', { mode: nextPreference as 'light' | 'dark' | 'system' })
  })

  const setThemeId = useStableCallback((id: string) => {
    setSingleThemeId(id)
    setSettingMutation.mutate({ key: 'app_theme_id', value: id })
    track('theme_changed', { themeId: id })
  })

  const setSplitThemes = useStableCallback((enabled: boolean) => {
    if (enabled) {
      setThemeIdDarkState(singleThemeId)
      setThemeIdLightState(singleThemeId)
      setSettingMutation.mutate({ key: 'app_theme_id_dark', value: singleThemeId })
      setSettingMutation.mutate({ key: 'app_theme_id_light', value: singleThemeId })
    }
    setSplitThemesState(enabled)
    setSettingMutation.mutate({ key: 'app_theme_split', value: enabled ? '1' : '0' })
  })

  const setThemeIdDark = useStableCallback((id: string) => {
    setThemeIdDarkState(id)
    setSettingMutation.mutate({ key: 'app_theme_id_dark', value: id })
  })

  const setThemeIdLight = useStableCallback((id: string) => {
    setThemeIdLightState(id)
    setSettingMutation.mutate({ key: 'app_theme_id_light', value: id })
  })

  const setTerminalOverrideThemeId = useStableCallback((id: string) => {
    setTerminalOverrideThemeIdState(id)
    setSettingMutation.mutate({ key: 'terminal_override_theme_id', value: id })
  })

  const setEditorOverrideThemeId = useStableCallback((id: string) => {
    setEditorOverrideThemeIdState(id)
    setSettingMutation.mutate({ key: 'editor_override_theme_id', value: id })
  })

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      preference,
      themeId,
      setPreference,
      setThemeId,
      splitThemes,
      setSplitThemes,
      themeIdDark,
      setThemeIdDark,
      themeIdLight,
      setThemeIdLight,
      terminalOverrideThemeId,
      setTerminalOverrideThemeId,
      editorOverrideThemeId,
      setEditorOverrideThemeId,
      terminalThemeId,
      editorThemeId,
      contentVariant
    }),
    [
      theme,
      preference,
      themeId,
      splitThemes,
      themeIdDark,
      themeIdLight,
      terminalOverrideThemeId,
      editorOverrideThemeId,
      terminalThemeId,
      editorThemeId,
      contentVariant,
      // Stable (useStableCallback); listed so the deps are complete.
      setPreference,
      setThemeId,
      setSplitThemes,
      setThemeIdDark,
      setThemeIdLight,
      setTerminalOverrideThemeId,
      setEditorOverrideThemeId
    ]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

// Consumer hook lives in @slayzone/ui (with the context); re-exported for settings-internal callers.
export { useTheme } from '@slayzone/ui'
