// Utilities
export { cn } from './utils'
export { isModalDialogOpen } from './is-modal-dialog-open'
export { withModalGuard } from './with-modal-guard'
export { useGuardedHotkeys } from './useGuardedHotkeys'
export {
  shortcutDefinitions,
  formatKeysForDisplay,
  withShortcut,
  toElectronAccelerator,
  matchesShortcut,
  SCOPE_PRIORITY,
  registry,
  scopeTracker,
  getBlockedWebPanelKeys,
  type ShortcutDefinition,
  type ShortcutScope
} from './shortcut-definitions'
export { useShortcutStore } from './useShortcutStore'
export { useShortcutDisplay } from './useShortcutDisplay'
export { useShortcutAction } from './useShortcutAction'
export { projectColorBg, type ProjectColorVariant } from './project-color'
export { WORKTREE_COLORS, hashStr, assignWorktreeColors, assignNewWorktreeColors } from './worktree-color'
export { useAppearance, AppearanceContext, appearanceDefaults, type AppearanceSettings, type BrowserDeviceDefaults } from './AppearanceContext'
export { getTerminalStateStyle, type TerminalStateStyle } from './terminal-state'
export {
  getTaskStatusStyle,
  getColumnStatusStyle,
  buildStatusOptions,
  TASK_STATUS_ORDER,
  taskStatusOptions,
  type TaskStatusStyle,
  type ColumnStatusConfig,
  type StatusOption
} from './task-status'
export { UndoProvider, useUndo, type UndoableAction } from './use-undo'

// Components
export * from './alert-dialog'
export * from './button'
export * from './icon-button'
export * from './calendar'
export * from './card'
export * from './checkbox'
export * from './collapsible'
export * from './color-picker'
export * from './command'
export * from './context-menu'
export * from './dialog'
export * from './diff-view'
export * from './dropdown-menu'
export * from './form'
export * from './input'
export * from './label'
export * from './popover'
export * from './select'
export * from './separator'
export * from './split-button'
export * from './sheet'
export * from './sidebar'
export * from './skeleton'
export * from './switch'
export * from './settings-layout'
export * from './tabs'
export * from './panel-toggle'
export * from './file-tree'
export * from './textarea'
export * from './tooltip'

// Toast
export { Toaster, toast } from 'sonner'

// Themes
export {
  unifiedThemes,
  getUnifiedTheme,
  getThemeVariant,
  getThemeChrome,
  getThemeTerminalColors,
  getThemeEditorColors,
  applyChromeColors,
  clearChromeColors,
  getChromeStyleOverrides,
  type UnifiedThemeDefinition,
  type UnifiedThemeVariant,
  type ChromeColors,
  type TerminalThemeColors,
} from './themes'
export type { EditorThemeColors } from './theme-types'

// Animations
export * from './AnimatedPage'
export * from './SuccessToast'
export * from './DevServerToast'
export * from './UpdateToast'
export * from './priority-icon'
