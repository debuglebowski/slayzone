import { useShortcutStore } from './useShortcutStore'
import { shortcutDefinitions, formatKeysForDisplay } from './shortcut-definitions'

/** Returns the formatted display string for a shortcut, reactive to user customization.
 *  Returns `null` when the shortcut is unbound (no default + no override, or explicitly cleared). */
export function useShortcutDisplay(id: string): string | null {
  const overrides = useShortcutStore(s => s.overrides)
  const def = shortcutDefinitions.find(d => d.id === id)
  const keys = id in overrides ? overrides[id] : (def?.defaultKeys ?? null)
  return formatKeysForDisplay(keys)
}
