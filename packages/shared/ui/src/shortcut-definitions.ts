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
  isPrimaryModifier,
  SCOPE_PRIORITY,
  registry,
  scopeTracker,
  getBlockedWebPanelKeys,
  webPanelShortcutKeys,
  type ShortcutDefinition,
  type ShortcutScope,
  type Platform
} from '@slayzone/shortcuts'
