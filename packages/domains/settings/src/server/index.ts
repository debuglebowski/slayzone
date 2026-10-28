export { SettingsService, type SettingsView, type ThemePreference } from './service'
export { settingsEvents, type SettingsEventMap } from './events'
export { settingProjectId, settingScope, type SettingScope } from './scope'
export { adoptLegacyUserSettings } from './adopt-legacy'
export { settingsRouter, type SettingsRouter, type SettingsMounts } from './router'
export { settingsWriteProcedure, settingWriteNeedsAdmin } from './settings-admin'
export {
  setSettingsHostDeps,
  getSettingsHostDeps,
  notifySettingsWritten,
  type SettingsHostDeps,
  type SettingsChange
} from './settings-host-deps'
