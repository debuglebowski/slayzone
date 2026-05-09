import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'
import type { Theme, ThemePreference } from '@slayzone/settings/shared'
import { track } from '@slayzone/telemetry/client'
import { applyTheme } from './apply-theme'

interface ThemeContextValue {
  // Core
  theme: Theme
  preference: ThemePreference
  themeId: string           // resolved chrome theme (accounts for split)
  setPreference: (pref: ThemePreference) => Promise<void>
  setThemeId: (id: string) => void

  // Split dark/light themes
  splitThemes: boolean
  setSplitThemes: (enabled: boolean) => void
  themeIdDark: string
  setThemeIdDark: (id: string) => void
  themeIdLight: string
  setThemeIdLight: (id: string) => void

  // Per-section overrides (empty string = same as app)
  terminalOverrideThemeId: string
  setTerminalOverrideThemeId: (id: string) => void
  editorOverrideThemeId: string
  setEditorOverrideThemeId: (id: string) => void

  // Resolved for consumers
  terminalThemeId: string
  editorThemeId: string
  contentVariant: Theme
}

const DEFAULT_THEME_ID = 'slay'

/** Maps old variant-specific IDs to unified family IDs */
const LEGACY_ID_MAP: Record<string, string> = {
  'slay-light': 'slay',
  'slay-special-light': 'slay-special',
  'default-light': 'default-dark',
  'catppuccin-mocha': 'catppuccin',
  'catppuccin-latte': 'catppuccin',
  'solarized-dark': 'solarized',
  'solarized-light': 'solarized',
  'tokyo-night-light': 'tokyo-night',
  'rose-pine-dawn': 'rose-pine',
}

function migrateThemeId(id: string): string {
  return LEGACY_ID_MAP[id] ?? id
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [theme, setTheme] = useState<Theme>('dark')
  const [preference, setPreferenceState] = useState<ThemePreference>('dark')

  // Single theme (when split off)
  const [singleThemeId, setSingleThemeId] = useState(DEFAULT_THEME_ID)

  // Split themes
  const [splitThemes, setSplitThemesState] = useState(false)
  const [themeIdDark, setThemeIdDarkState] = useState(DEFAULT_THEME_ID)
  const [themeIdLight, setThemeIdLightState] = useState(DEFAULT_THEME_ID)

  // Per-section overrides (empty = same as app)
  const [terminalOverrideThemeId, setTerminalOverrideThemeIdState] = useState('')
  const [editorOverrideThemeId, setEditorOverrideThemeIdState] = useState('')

  // Resolved
  const themeId = splitThemes
    ? (theme === 'dark' ? themeIdDark : themeIdLight)
    : singleThemeId
  const terminalThemeId = terminalOverrideThemeId || themeId
  const editorThemeId = editorOverrideThemeId || themeId
  const contentVariant = theme

  useEffect(() => {
    let disposed = false
    performance.mark('sz:theme:start')

    const initialize = async () => {
      const [
        effective, source,
        savedThemeId, savedSplit, savedDark, savedLight,
        savedTermOvrId, savedEditorOvrId,
      ] = await Promise.all([
        trpcClient.settings.getEffectiveTheme.query(),
        trpcClient.settings.getThemeSource.query(),
        trpcClient.settings.get.query({ key: 'app_theme_id' }),
        trpcClient.settings.get.query({ key: 'app_theme_split' }),
        trpcClient.settings.get.query({ key: 'app_theme_id_dark' }),
        trpcClient.settings.get.query({ key: 'app_theme_id_light' }),
        trpcClient.settings.get.query({ key: 'terminal_override_theme_id' }),
        trpcClient.settings.get.query({ key: 'editor_override_theme_id' }),
      ])
      if (disposed) return

      // Migrate single theme from legacy
      let resolvedId = savedThemeId
      if (!resolvedId) {
        const legacyId = await trpcClient.settings.get.query({ key: 'content_theme_dark' })
          .then(v => v ?? trpcClient.settings.get.query({ key: 'terminal_theme_dark' }))
        resolvedId = migrateThemeId(legacyId ?? DEFAULT_THEME_ID)
        trpcClient.settings.set.mutate({ key: 'app_theme_id', value: resolvedId })
      } else {
        resolvedId = migrateThemeId(resolvedId)
      }

      const isSplit = savedSplit === '1'
      const darkId = migrateThemeId(savedDark ?? resolvedId)
      const lightId = migrateThemeId(savedLight ?? resolvedId)

      setTheme(effective)
      setPreferenceState(source)
      setSingleThemeId(resolvedId)
      setSplitThemesState(isSplit)
      setThemeIdDarkState(darkId)
      setThemeIdLightState(lightId)
      setTerminalOverrideThemeIdState(savedTermOvrId ? migrateThemeId(savedTermOvrId) : '')
      setEditorOverrideThemeIdState(savedEditorOvrId ? migrateThemeId(savedEditorOvrId) : '')

      const chromeId = isSplit ? (effective === 'dark' ? darkId : lightId) : resolvedId
      applyTheme(effective, chromeId)
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
  }, [trpcClient])

  useSubscription(
    trpc.settings.onThemeChanged.subscriptionOptions(undefined, {
      onData: (effective) => {
        setTheme(effective)
      },
    }),
  )

  // Re-apply chrome whenever resolved themeId or theme changes
  useEffect(() => {
    applyTheme(theme, themeId)
  }, [theme, themeId])

  const setPreference = async (nextPreference: ThemePreference) => {
    const effective = await trpcClient.settings.setTheme.mutate(nextPreference)
    setPreferenceState(nextPreference)
    setTheme(effective)
    track('theme_changed', { mode: nextPreference as 'light' | 'dark' | 'system' })
  }

  const setThemeId = (id: string) => {
    setSingleThemeId(id)
    trpcClient.settings.set.mutate({ key: 'app_theme_id', value: id })
    track('theme_changed', { themeId: id })
  }

  const setSplitThemes = (enabled: boolean) => {
    if (enabled) {
      setThemeIdDarkState(singleThemeId)
      setThemeIdLightState(singleThemeId)
      trpcClient.settings.set.mutate({ key: 'app_theme_id_dark', value: singleThemeId })
      trpcClient.settings.set.mutate({ key: 'app_theme_id_light', value: singleThemeId })
    }
    setSplitThemesState(enabled)
    trpcClient.settings.set.mutate({ key: 'app_theme_split', value: enabled ? '1' : '0' })
  }

  const setThemeIdDark = (id: string) => {
    setThemeIdDarkState(id)
    trpcClient.settings.set.mutate({ key: 'app_theme_id_dark', value: id })
  }

  const setThemeIdLight = (id: string) => {
    setThemeIdLightState(id)
    trpcClient.settings.set.mutate({ key: 'app_theme_id_light', value: id })
  }

  const setTerminalOverrideThemeId = (id: string) => {
    setTerminalOverrideThemeIdState(id)
    trpcClient.settings.set.mutate({ key: 'terminal_override_theme_id', value: id })
  }

  const setEditorOverrideThemeId = (id: string) => {
    setEditorOverrideThemeIdState(id)
    trpcClient.settings.set.mutate({ key: 'editor_override_theme_id', value: id })
  }

  const value = useMemo<ThemeContextValue>(() => ({
    theme, preference, themeId,
    setPreference, setThemeId,
    splitThemes, setSplitThemes,
    themeIdDark, setThemeIdDark,
    themeIdLight, setThemeIdLight,
    terminalOverrideThemeId, setTerminalOverrideThemeId,
    editorOverrideThemeId, setEditorOverrideThemeId,
    terminalThemeId, editorThemeId, contentVariant,
  }), [theme, preference, themeId, splitThemes, themeIdDark, themeIdLight, terminalOverrideThemeId, editorOverrideThemeId, terminalThemeId, editorThemeId, contentVariant])

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
