/**
 * Host deps of the settings router — what it needs that this domain cannot own:
 * `onSettingsWritten`, telling every window which keys a write changed (api's notify
 * bus, `notify.onSettingsChanged`). The theme mode is not a hub setting at all (each
 * device's client host keeps it; the router's theme paths answer constants).
 *
 * api calls `setSettingsHostDeps()` once at load (`app-deps.ts`), so every host
 * that composes the app router has it wired.
 *
 * @module settings-core/server/settings-host-deps
 */

/** The setting keys a write changed (`notify.onSettingsChanged`'s payload). */
export interface SettingsChange {
  keys: readonly string[]
}

export type SettingsHostDeps = {
  onSettingsWritten: (change: SettingsChange) => void
}

let settingsHostDeps: SettingsHostDeps | null = null

export function setSettingsHostDeps(deps: SettingsHostDeps): void {
  settingsHostDeps = deps
}

export function getSettingsHostDeps(): SettingsHostDeps {
  if (!settingsHostDeps)
    throw new Error('settingsHostDeps not initialized — call setSettingsHostDeps() first')
  return settingsHostDeps
}

/**
 * Signal that settings were written. Best-effort: a host that wired nothing (unit
 * harnesses) has no subscriber to tell.
 */
export function notifySettingsWritten(change: SettingsChange): void {
  settingsHostDeps?.onSettingsWritten(change)
}
