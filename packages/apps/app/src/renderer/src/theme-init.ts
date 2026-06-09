import { applyTheme } from '@slayzone/settings/client'

// Default dark with CSS fallback, then resolve persisted preference + theme.
applyTheme('dark')
// STAYS ON BRIDGE: this module is loaded as a standalone <script type="module">
// in index.html and runs at page load — before React mounts TrpcProvider and the
// tRPC port is discovered, so the tRPC client is not yet available here.
void Promise.all([window.api.theme.getEffective(), window.api.settings.get('app_theme_id')])
  .then(([effective, themeId]) => {
    applyTheme(effective === 'light' ? 'light' : 'dark', themeId ?? undefined)
  })
  .catch(() => {})
