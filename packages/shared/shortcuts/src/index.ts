export { detectPlatform, type Platform } from './platform'
export { type ShortcutScope, SCOPE_PRIORITY } from './scope'
export {
  shortcutDefinitions,
  MENU_SHORTCUT_DEFAULTS,
  type ShortcutDefinition,
} from './definitions'
export { toElectronAccelerator, matchesShortcut, matchesElectronInput, formatKeysForDisplay, withShortcut, type ElectronInput } from './accelerator'
export { registry, ShortcutRegistry, type HandlerEntry } from './registry'
export { scopeTracker, ScopeTracker } from './scope-tracker'
export { getBlockedWebPanelKeys } from './blocked-keys'
