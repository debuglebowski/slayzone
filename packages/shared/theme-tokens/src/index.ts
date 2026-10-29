/**
 * @slayzone/theme-tokens — the app's theme presets as plain data, and the pure logic
 * around them. No DOM, no React, no Node: desktop (through `@slayzone/ui`, which paints
 * them as CSS variables) and the React Native app read the same presets.
 */
export type {
  ChromeColors,
  TerminalThemeColors,
  EditorThemeColors,
  UnifiedThemeVariant,
  UnifiedThemeDefinition,
  Theme,
  ThemePreference
} from './types'
export {
  unifiedThemes,
  getUnifiedTheme,
  getThemeVariant,
  getThemeChrome,
  getThemeTerminalColors,
  getThemeEditorColors
} from './themes'
export {
  DEFAULT_THEME_ID,
  LEGACY_ID_MAP,
  migrateThemeId,
  APP_THEME_SETTING_KEYS,
  LEGACY_THEME_SETTING_KEYS,
  resolveAppThemeSelection,
  selectChromeThemeId,
  resolveThemeVariant,
  type StoredAppTheme,
  type AppThemeSelection
} from './selection'
export { parseColor, formatHex, toHex, withAlpha, toHexColors, type Rgba } from './color'
export { getThemeChromeHex } from './chrome-hex'
export { resolveNativeTheme, type HubThemeSettings, type NativeTheme } from './native-theme'
export {
  createHubThemeCache,
  pickHubThemeSettings,
  type HubThemeCache,
  type HubThemeCacheStorage
} from './hub-theme-cache'
