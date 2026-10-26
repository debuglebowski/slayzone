// Re-export from @slayzone/shortcuts for backwards compatibility
export {
  shortcutDefinitions,
  resolveShortcutKeys,
  toElectronAccelerator,
  matchesShortcut,
  formatKeysForDisplay,
  formatKeysVerbose,
  withShortcut,
  detectPlatform,
  SCOPE_PRIORITY,
  registry,
  scopeTracker,
  getBlockedWebPanelKeys,
  type ShortcutDefinition,
  type ShortcutScope,
  type Platform
} from '@slayzone/shortcuts'
