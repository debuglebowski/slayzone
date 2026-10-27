export { useDialogStore, type SearchFileContext } from './useDialogStore'
// UserSettingsDialog / CliInstallDialog are NOT re-exported here: this barrel is
// on the startup path (stores, theme), and the dialogs (all settings tabs) load
// lazily via their own entries — `@slayzone/settings/client/UserSettingsDialog`,
// `@slayzone/settings/client/CliInstallDialog`.
export { ThemeProvider, useTheme } from './ThemeContext'
export { applyTheme } from './apply-theme'
export { readThemeCache, resolveThemeCache } from './theme-cache'
export {
  useTabStore,
  tabStoreReady,
  loadTabStoreState,
  type Tab,
  type ClosedTab,
  type ClosedTabRestorer,
  type ActiveView,
  type TreeGroupBy,
  type TreeOrderBy,
  type TreeOrderDir,
  type TaskHeaderPanelMode,
  type TaskHeaderAlign
} from './useTabStore'
export { AppearanceProvider } from './AppearanceContext'
export { requestSettingsReopen } from './settings-reopen'
export { useSettingsReopenTab } from './useSettingsReopenTab'
export { useAppearance, type AppearanceSettings } from '@slayzone/ui'
export type { CreateTaskDraft } from '@slayzone/task/shared'
