import { applyTheme, readThemeCache, resolveThemeCache } from '@slayzone/settings/client'

// Paint the last-applied theme before React mounts (ThemeProvider caches it on
// every change); first launch has no cache → default dark with CSS fallback.
// ThemeProvider then resolves the persisted preference + theme from the hub.
const cached = readThemeCache()
if (cached) {
  const { theme, themeId } = resolveThemeCache(cached)
  applyTheme(theme, themeId)
} else {
  applyTheme('dark')
}
