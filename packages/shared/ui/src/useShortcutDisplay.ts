import { useShortcutStore } from './useShortcutStore'
import { shortcutDefinitions, formatKeysForDisplay, formatKeysVerbose } from './shortcut-definitions'

/** Returns the formatted display string for a shortcut, reactive to user customization.
 *  Returns `null` when the shortcut is unbound (no default + no override, or explicitly cleared).
 *  `format` controls style: 'glyph' (default, e.g. "⌃.") or 'verbose' (e.g. "Ctrl+."). */
export function useShortcutDisplay(id: string, format: 'glyph' | 'verbose' = 'glyph'): string | null {
  const overrides = useShortcutStore(s => s.overrides)
  const def = shortcutDefinitions.find(d => d.id === id)
  const keys = id in overrides ? overrides[id] : (def?.defaultKeys ?? null)
  return format === 'verbose' ? formatKeysVerbose(keys) : formatKeysForDisplay(keys)
}
