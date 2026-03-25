import { useShortcutStore } from './useShortcutStore'
import { shortcutDefinitions, formatKeysForDisplay } from './shortcut-definitions'

/** Returns the formatted display string for a shortcut, reactive to user customization. */
export function useShortcutDisplay(id: string): string {
  const override = useShortcutStore(s => s.overrides[id])
  const def = shortcutDefinitions.find(d => d.id === id)
  return formatKeysForDisplay(override ?? def?.defaultKeys ?? '')
}
