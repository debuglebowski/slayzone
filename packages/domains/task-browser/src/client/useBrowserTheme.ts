import { useCallback, useRef } from 'react'
import type { BrowserTab, BrowserTabTheme } from '../shared'
import { THEME_CSS, THEME_CYCLE } from './BrowserPanel.constants'
import type { BrowserTabPlaceholderHandle } from './BrowserTabPlaceholder'

interface UseBrowserThemeParams {
  activeActions: BrowserTabPlaceholderHandle['actions'] | undefined
  activeTab: BrowserTab | null
  updateActiveTab: (patch: Partial<BrowserTab>) => void
}

export function useBrowserTheme({
  activeActions,
  activeTab,
  updateActiveTab
}: UseBrowserThemeParams) {
  const darkModeCSSKeyRef = useRef<string | null>(null)

  const applyThemeCss = useCallback(
    (mode: BrowserTabTheme) => {
      if (!activeActions) return
      void (async () => {
        const key = darkModeCSSKeyRef.current
        if (key) {
          darkModeCSSKeyRef.current = null
          activeActions.removeCss(key)
        }
        const css = mode === 'system' ? null : THEME_CSS[mode]
        if (css) darkModeCSSKeyRef.current = (await activeActions.insertCss(css)) || null
      })()
    },
    [activeActions]
  )

  const cycleTheme = useCallback(() => {
    if (!activeTab) return
    const current = activeTab.themeMode ?? 'system'
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length]
    updateActiveTab({ themeMode: next })
    applyThemeCss(next)
  }, [activeTab, updateActiveTab, applyThemeCss])

  return { applyThemeCss, cycleTheme }
}
