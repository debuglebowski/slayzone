import { createContext, useContext } from 'react'
import type { Theme, ThemePreference } from './theme-types'

/**
 * Theme context: the consumer half (`useTheme`) lives here, the provider
 * (`ThemeProvider`, which persists and syncs over tRPC) lives in
 * `@slayzone/settings`. Same split as `AppearanceContext`, so packages that
 * only READ the theme (file-editor, terminal, …) need not depend on settings.
 */
export interface ThemeContextValue {
  // Core
  theme: Theme
  preference: ThemePreference
  themeId: string // resolved chrome theme (accounts for split)
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
  contentVariant: 'light' | 'dark'
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
