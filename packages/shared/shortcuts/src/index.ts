export { detectPlatform, isPrimaryModifier, type Platform } from './platform'
export { type ShortcutScope, SCOPE_PRIORITY } from './scope'
export {
  shortcutDefinitions,
  MENU_SHORTCUT_DEFAULTS,
  SHORTCUT_DEFAULT_MIGRATIONS,
  SHORTCUT_ID_RENAMES,
  type ShortcutDefinition
} from './definitions'
export {
  toElectronAccelerator,
  matchesShortcut,
  matchesElectronInput,
  formatKeysForDisplay,
  formatKeysVerbose,
  withShortcut,
  normalizeHotkeyString,
  type ElectronInput
} from './accelerator'
export { registry, ShortcutRegistry, type HandlerEntry } from './registry'
export { scopeTracker, ScopeTracker } from './scope-tracker'
export { getBlockedWebPanelKeys } from './blocked-keys'
