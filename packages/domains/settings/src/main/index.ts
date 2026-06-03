export { registerSettingsHandlers } from './handlers'
export {
  registerThemeHandlers,
  getEffectiveTheme,
  getThemeSource,
  setTheme,
  wireNativeThemeBridge
} from './theme'
export { SettingsService, type ThemePreference } from '../server/service'
