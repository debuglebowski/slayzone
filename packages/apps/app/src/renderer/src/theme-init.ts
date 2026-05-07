import { applyTheme } from '@slayzone/settings/client'
import { getTrpcVanillaClient } from '@slayzone/transport/client'

// Default dark with CSS fallback, then resolve persisted preference + theme.
applyTheme('dark')
void Promise.all([
  getTrpcVanillaClient().settings.getEffectiveTheme.query(),
  getTrpcVanillaClient().settings.get.query({ key: 'app_theme_id' }),
]).then(([effective, themeId]) => {
  applyTheme(effective === 'light' ? 'light' : 'dark', themeId ?? undefined)
}).catch(() => {})
