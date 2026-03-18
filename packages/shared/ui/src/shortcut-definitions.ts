export type ShortcutScope = 'global' | 'task-panel' | 'terminal'

export type ShortcutDefinition = {
  id: string
  label: string
  group: string
  defaultKeys: string
  scope: ShortcutScope
  platform?: 'mac'
  customizable?: boolean // defaults to true
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

export const shortcutDefinitions: ShortcutDefinition[] = [
  // General (global scope)
  { id: 'new-task', label: 'New Task', group: 'General', defaultKeys: 'mod+n', scope: 'global' },
  { id: 'search', label: 'Search', group: 'General', defaultKeys: 'mod+k', scope: 'global' },
  { id: 'complete-close-tab', label: 'Complete & Close Tab', group: 'General', defaultKeys: 'mod+shift+d', scope: 'global' },
  { id: 'zen-mode', label: 'Zen Mode', group: 'General', defaultKeys: 'mod+j', scope: 'global' },
  { id: 'explode-mode', label: 'Explode Mode', group: 'General', defaultKeys: 'mod+shift+e', scope: 'global' },
  { id: 'exit-zen-explode', label: 'Exit Zen / Explode', group: 'General', defaultKeys: 'escape', scope: 'global' },
  { id: 'global-settings', label: 'Global Settings', group: 'General', defaultKeys: 'mod+,', scope: 'global' },
  { id: 'project-settings', label: 'Project Settings', group: 'General', defaultKeys: 'mod+shift+,', scope: 'global' },
  ...(isMac ? [{ id: 'go-home', label: 'Go Home', group: 'General', defaultKeys: 'mod+§', scope: 'global' as const, platform: 'mac' as const }] : []),
  { id: 'undo', label: 'Undo', group: 'General', defaultKeys: 'mod+z', scope: 'global', customizable: false },
  { id: 'redo', label: 'Redo', group: 'General', defaultKeys: 'mod+shift+z', scope: 'global', customizable: false },

  // Tabs (global scope)
  { id: 'close-tab', label: 'Close Sub-panel / Tab', group: 'Tabs', defaultKeys: 'mod+w', scope: 'global' },
  { id: 'close-task', label: 'Close Task', group: 'Tabs', defaultKeys: 'mod+shift+w', scope: 'global' },
  { id: 'switch-tab-1-9', label: 'Switch Tab 1–9', group: 'Tabs', defaultKeys: 'mod+1-9', scope: 'global', customizable: false },
  { id: 'next-tab', label: 'Next Tab', group: 'Tabs', defaultKeys: 'ctrl+tab', scope: 'global' },
  { id: 'prev-tab', label: 'Previous Tab', group: 'Tabs', defaultKeys: 'ctrl+shift+tab', scope: 'global' },
  { id: 'reopen-closed-tab', label: 'Reopen Closed Tab', group: 'Tabs', defaultKeys: 'mod+shift+t', scope: 'global' },
  { id: 'new-temp-task', label: 'New Temporary Task', group: 'Tabs', defaultKeys: 'mod+shift+n', scope: 'global' },
  { id: 'switch-project-1-9', label: 'Switch Project 1–9', group: 'Tabs', defaultKeys: 'mod+shift+1-9', scope: 'global', customizable: false },

  // Task Panels (task-panel scope)
  { id: 'panel-terminal', label: 'Terminal', group: 'Task Panels', defaultKeys: 'mod+t', scope: 'task-panel' },
  { id: 'panel-browser', label: 'Browser', group: 'Task Panels', defaultKeys: 'mod+b', scope: 'task-panel' },
  { id: 'panel-editor', label: 'Editor', group: 'Task Panels', defaultKeys: 'mod+e', scope: 'task-panel' },
  { id: 'panel-quick-open', label: 'Quick Open File', group: 'Task Panels', defaultKeys: 'mod+p', scope: 'task-panel' },
  { id: 'panel-git', label: 'Git', group: 'Task Panels', defaultKeys: 'mod+g', scope: 'task-panel' },
  { id: 'panel-git-diff', label: 'Git Diff', group: 'Task Panels', defaultKeys: 'mod+shift+g', scope: 'task-panel' },
  { id: 'panel-settings', label: 'Settings', group: 'Task Panels', defaultKeys: 'mod+s', scope: 'task-panel' },

  // Terminal (terminal scope)
  { id: 'terminal-inject-title', label: 'Inject Title', group: 'Terminal', defaultKeys: 'mod+i', scope: 'terminal' },
  { id: 'terminal-inject-desc', label: 'Inject Description', group: 'Terminal', defaultKeys: 'mod+shift+i', scope: 'terminal' },
  { id: 'terminal-screenshot', label: 'Screenshot', group: 'Terminal', defaultKeys: 'mod+shift+s', scope: 'terminal' },
  { id: 'terminal-search', label: 'Search', group: 'Terminal', defaultKeys: 'mod+f', scope: 'terminal' },
  { id: 'terminal-clear', label: 'Clear Buffer', group: 'Terminal', defaultKeys: 'mod+shift+k', scope: 'terminal' },
  { id: 'terminal-new-group', label: 'New Group', group: 'Terminal', defaultKeys: 'mod+t', scope: 'terminal' },
  { id: 'terminal-split', label: 'Split', group: 'Terminal', defaultKeys: 'mod+d', scope: 'terminal' },
]

const DISPLAY_MAP_MAC: Record<string, string> = {
  mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃',
}
const DISPLAY_MAP_OTHER: Record<string, string> = {
  mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl',
}

export function formatKeysForDisplay(keys: string): string {
  const map = isMac ? DISPLAY_MAP_MAC : DISPLAY_MAP_OTHER
  return keys.split('+').map(part => {
    const mapped = map[part]
    if (mapped) return mapped
    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
  }).join(' ')
}

/**
 * Check if a KeyboardEvent matches a shortcut string like "mod+g" or "mod+shift+g".
 * Used by raw keydown handlers that can't use react-hotkeys-hook.
 */
export function matchesShortcut(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.split('+')
  const key = parts[parts.length - 1]
  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const wantCtrl = parts.includes('ctrl')

  const hasMod = isMac ? e.metaKey : e.ctrlKey
  if (wantMod !== hasMod) return false
  if (wantShift !== e.shiftKey) return false
  if (wantAlt !== e.altKey) return false
  if (wantCtrl !== (isMac ? e.ctrlKey : false)) return false

  return e.key.toLowerCase() === key
}

export function toElectronAccelerator(keys: string): string {
  return keys.split('+').map(part => {
    if (part === 'mod') return 'CmdOrCtrl'
    if (part === 'shift') return 'Shift'
    if (part === 'alt') return 'Alt'
    if (part === 'ctrl') return 'Ctrl'
    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
  }).join('+')
}
