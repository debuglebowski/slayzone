import { SHORTCUT_DEFAULT_MIGRATIONS, SHORTCUT_ID_RENAMES } from './definitions'

export type ShortcutOverrides = Record<string, string | null>

/**
 * A stored shortcut-override map, brought up to date: legacy ids renamed, overrides
 * that still equal a retired default cleared (so the new default applies), and the
 * old `''` clear read as unbound (`null`). Anything else that is not a string or
 * null is dropped.
 *
 * Pure, and the ONE place these rules run: the renderer store on load, Electron main
 * on every read of `client.config.json` (the native menu and `before-input-event`
 * matcher), and the one-time adoption of a hub's value. A raw copy that skipped it
 * would bring a retired id back.
 *
 * `changed` = the result differs from the input, i.e. worth persisting.
 */
export function normalizeShortcutOverrides(raw: unknown): {
  overrides: ShortcutOverrides
  changed: boolean
} {
  if (raw === null || raw === undefined) return { overrides: {}, changed: false }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { overrides: {}, changed: true }
  const src = { ...(raw as Record<string, unknown>) }
  let changed = false
  // Renames first, so the default migrations below apply on the new id.
  for (const { from, to } of SHORTCUT_ID_RENAMES) {
    if (from in src) {
      if (!(to in src)) src[to] = src[from]
      delete src[from]
      changed = true
    }
  }
  for (const { id, oldDefault } of SHORTCUT_DEFAULT_MIGRATIONS) {
    if (src[id] === oldDefault) {
      delete src[id]
      changed = true
    }
  }
  const overrides: ShortcutOverrides = {}
  for (const [id, value] of Object.entries(src)) {
    if (value === '') {
      overrides[id] = null
      changed = true
    } else if (typeof value === 'string' || value === null) {
      overrides[id] = value
    } else {
      changed = true
    }
  }
  return { overrides, changed }
}
