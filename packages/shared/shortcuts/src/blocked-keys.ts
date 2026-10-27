import { shortcutDefinitions } from './definitions'

/** OS-level or native-edit Cmd+letter shortcuts that aren't in our definitions. */
const OS_RESERVED_KEYS = new Set([
  'h',
  'q',
  'm', // macOS system (hide, quit, minimize)
  'c',
  'v',
  'x',
  'a' // native edit (copy, paste, cut, select-all)
])

/**
 * The shortcut a web panel binds: primary modifier + its stored letter (`'y'` → `'mod+y'`,
 * ⌘Y on macOS, Ctrl+Y elsewhere). Panels store only the letter (every writer validates a
 * single lowercase a–z), so the keydown matcher and the tab label both derive the combo
 * here and cannot drift apart. Null when the panel has no shortcut.
 */
export function webPanelShortcutKeys(letter: string | null | undefined): string | null {
  return letter ? `mod+${letter}` : null
}

/**
 * Compute which single letters cannot be used as web panel shortcuts (Cmd+{letter}).
 * Derived from actual shortcut definitions (global + task scope Cmd+letter bindings)
 * plus OS-level reserved keys.
 *
 * Only checks mod+{letter} — mod+shift+{letter} is a different combo and doesn't conflict.
 */
export function getBlockedWebPanelKeys(): Set<string> {
  const blocked = new Set(OS_RESERVED_KEYS)

  for (const def of shortcutDefinitions) {
    // Only global and task scopes conflict — component scopes (editor/terminal/browser)
    // are higher priority and only active when that component has focus.
    if (def.scope !== 'global' && def.scope !== 'task') continue

    // Match mod+{single letter} only (not mod+shift+letter, mod+alt+letter, etc.)
    if (def.defaultKeys === null) continue
    const match = def.defaultKeys.match(/^mod\+([a-z])$/)
    if (match) blocked.add(match[1])
  }

  return blocked
}
