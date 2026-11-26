import { normalizeShortcutOverrides, type ShortcutOverrides } from './normalize'

export interface AdoptShortcutsDeps {
  /** The client file's `shortcutsOwnedByDevice` marker (adopted before, or edited
   *  locally — either way the device's map wins). */
  alreadyAdopted: boolean
  /** The default hub's `custom_shortcuts` (JSON, or null when it has none). Throws
   *  when the hub cannot be read. */
  readHub: () => Promise<string | null>
  /** Write the map AND the marker in one step (the client host's `shortcuts.set`
   *  with `adoptedFromHub`). */
  write: (overrides: ShortcutOverrides) => Promise<unknown>
}

/**
 * The one-time copy of a hub's shortcut overrides into this device's client file
 * (D1: the file is authoritative from then on).
 *
 * An OVERWRITE, not copy-if-absent: every upgraded user's file already holds the
 * values the 0.36 migration copied, which nothing has updated since (the renderer
 * kept writing the hub). The marker is written only together with a successfully
 * read value — a failed read (or write) leaves it unset and the next boot retries,
 * so the user's real overrides are never lost to a transient outage.
 */
export async function adoptShortcutsFromHub(
  deps: AdoptShortcutsDeps
): Promise<'adopted' | 'skipped' | 'failed'> {
  if (deps.alreadyAdopted) return 'skipped'
  let parsed: unknown
  try {
    const raw = await deps.readHub()
    parsed = raw === null ? {} : JSON.parse(raw)
  } catch {
    return 'failed'
  }
  try {
    await deps.write(normalizeShortcutOverrides(parsed).overrides)
    return 'adopted'
  } catch {
    return 'failed'
  }
}
