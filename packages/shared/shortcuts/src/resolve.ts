import { shortcutDefinitions } from './definitions'

/**
 * Effective key combo for a shortcut. Any override beats the default — including a
 * cleared one (`null` = unbound; `''` from before clears were stored as null).
 * The one resolver for every reader of user overrides: renderer and main process.
 */
export function resolveShortcutKeys(
  overrides: Record<string, string | null>,
  id: string
): string | null {
  if (id in overrides) return overrides[id]
  return shortcutDefinitions.find((d) => d.id === id)?.defaultKeys ?? null
}
