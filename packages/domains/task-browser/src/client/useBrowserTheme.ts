import { useCallback } from 'react'
import type { BrowserTab } from '../shared'
import { THEME_CYCLE } from './BrowserPanel.constants'

interface UseBrowserThemeParams {
  activeTab: BrowserTab | null
  updateActiveTab: (patch: Partial<BrowserTab>) => void
}

/**
 * Owns the toggle only. Applying the theme belongs to the main process, keyed
 * by viewId — `BrowserTabPlaceholder` declares `themeMode` and the manager
 * re-applies it across navigation, reload and crash.
 *
 * It used to be applied from here, via a single `insertCss` at the moment of
 * the click. Two bugs came out of that: the CSS was never re-applied, so a tab
 * persisted as dark reloaded unstyled; and the returned key lived in one ref
 * for the whole panel rather than per tab, so toggling on one tab tried to
 * remove another tab's stylesheet and leaked the original for good.
 */
export function useBrowserTheme({ activeTab, updateActiveTab }: UseBrowserThemeParams) {
  const cycleTheme = useCallback(() => {
    if (!activeTab) return
    const current = activeTab.themeMode ?? 'system'
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length]
    updateActiveTab({ themeMode: next })
  }, [activeTab, updateActiveTab])

  return { cycleTheme }
}
