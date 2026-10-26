import { useShortcutStore } from './useShortcutStore'
import {
  resolveShortcutKeys,
  formatKeysForDisplay,
  formatKeysVerbose
} from './shortcut-definitions'

/** Returns the formatted display string for a shortcut, reactive to user customization.
 *  Returns `null` when the shortcut is unbound (no default + no override, or explicitly cleared).
 *  `format` controls style: 'glyph' (default, e.g. "⌃.") or 'verbose' (e.g. "Ctrl+."). */
export function useShortcutDisplay(
  id: string,
  format: 'glyph' | 'verbose' = 'glyph'
): string | null {
  const keys = useShortcutStore((s) => resolveShortcutKeys(s.overrides, id))
  return format === 'verbose' ? formatKeysVerbose(keys) : formatKeysForDisplay(keys)
}
