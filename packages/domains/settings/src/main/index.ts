export { registerSettingsHandlers } from './handlers'
export { registerThemeHandlers } from './theme'
export {
  getEffectiveTheme,
  getThemeSource,
  setTheme,
  wireNativeThemeBridge
} from './theme-core'
export { SettingsService, type ThemePreference } from '../server/service'
