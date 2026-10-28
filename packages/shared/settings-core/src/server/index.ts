/**
 * The settings server: the `settings` router, its service, key scopes, events and
 * host seam. A base package (deps: platform, trpc-server) so every domain client can
 * type its `settings.*` calls (`SettingsMounts`) without a cycle through
 * `@slayzone/settings`, which keeps the settings UI and `app.backup`.
 *
 * @module settings-core/server
 */
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
