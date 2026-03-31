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

export const shortcutDefinitions: ShortcutDefinition[] = [
  // General (global scope)
  { id: 'new-task', label: 'New Task', group: 'General', defaultKeys: 'mod+n', scope: 'global' },
  { id: 'search', label: 'Search', group: 'General', defaultKeys: 'mod+k', scope: 'global' },
  { id: 'complete-close-tab', label: 'Complete & Close Tab', group: 'General', defaultKeys: 'mod+shift+d', scope: 'global' },
  { id: 'zen-mode', label: 'Zen Mode', group: 'General', defaultKeys: 'mod+j', scope: 'global' },
  { id: 'explode-mode', label: 'Explode Mode', group: 'General', defaultKeys: 'mod+shift+e', scope: 'global' },
  { id: 'exit-zen-explode', label: 'Exit Zen / Explode', group: 'General', defaultKeys: 'escape', scope: 'global' },
  { id: 'attention-panel', label: 'Attention Panel', group: 'General', defaultKeys: 'mod+shift+a', scope: 'global' },
  { id: 'global-settings', label: 'Global Settings', group: 'General', defaultKeys: 'mod+,', scope: 'global' },
  { id: 'project-settings', label: 'Project Settings', group: 'General', defaultKeys: 'mod+shift+,', scope: 'global' },
  { id: 'go-home', label: 'Go Home', group: 'General', defaultKeys: 'mod+§', scope: 'global', platform: 'mac' },
  { id: 'reload-browser', label: 'Reload Browser', group: 'General', defaultKeys: 'mod+r', scope: 'global', customizable: false },
  { id: 'reload-app', label: 'Reload App', group: 'General', defaultKeys: 'mod+shift+r', scope: 'global', customizable: false },
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
  { id: 'panel-processes', label: 'Processes', group: 'Task Panels', defaultKeys: 'mod+o', scope: 'task-panel' },
  { id: 'panel-tests', label: 'Tests', group: 'Task Panels', defaultKeys: 'mod+u', scope: 'task-panel' },
  { id: 'panel-automations', label: 'Automations', group: 'Task Panels', defaultKeys: 'mod+y', scope: 'task-panel' },
  { id: 'editor-search', label: 'Editor Search', group: 'Task Panels', defaultKeys: 'mod+shift+f', scope: 'task-panel' },
  { id: 'browser-element-picker', label: 'Element Picker', group: 'Task Panels', defaultKeys: 'mod+shift+l', scope: 'task-panel' },

  // Terminal (terminal scope)
  { id: 'terminal-inject-title', label: 'Inject Title', group: 'Terminal', defaultKeys: 'mod+i', scope: 'terminal' },
  { id: 'terminal-inject-desc', label: 'Inject Description', group: 'Terminal', defaultKeys: 'mod+shift+i', scope: 'terminal' },
  { id: 'terminal-screenshot', label: 'Screenshot', group: 'Terminal', defaultKeys: 'mod+shift+s', scope: 'terminal' },
  { id: 'terminal-search', label: 'Search', group: 'Terminal', defaultKeys: 'mod+f', scope: 'terminal' },
  { id: 'terminal-clear', label: 'Clear Buffer', group: 'Terminal', defaultKeys: 'mod+shift+k', scope: 'terminal' },
  { id: 'terminal-new-group', label: 'New Group', group: 'Terminal', defaultKeys: 'mod+t', scope: 'terminal' },
  { id: 'terminal-split', label: 'Split', group: 'Terminal', defaultKeys: 'mod+d', scope: 'terminal' },
  { id: 'terminal-restart', label: 'Restart', group: 'Terminal', defaultKeys: 'mod+alt+r', scope: 'terminal' },

  // Browser (task-panel scope)
  { id: 'browser-focus-url', label: 'Focus URL Bar', group: 'Task Panels', defaultKeys: 'mod+l', scope: 'task-panel' },
]

/** Shortcut IDs that are driven by Electron native menu accelerators. */
const MENU_SHORTCUT_IDS = ['global-settings', 'project-settings', 'new-temp-task', 'close-tab', 'close-task'] as const

/** Default keys for menu-driven shortcuts, derived from shortcutDefinitions. */
export const MENU_SHORTCUT_DEFAULTS: Record<string, string> = Object.fromEntries(
  shortcutDefinitions
    .filter(d => (MENU_SHORTCUT_IDS as readonly string[]).includes(d.id))
    .map(d => [d.id, d.defaultKeys])
)
