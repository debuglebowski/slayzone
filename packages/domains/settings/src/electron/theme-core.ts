import { nativeTheme } from 'electron'
import type { ThemePreference } from '@slayzone/settings-core/server'
import { updateClientSettings } from '@slayzone/platform/client-settings'

/**
 * The theme mode on Electron's `nativeTheme` — main's side of the client host's
 * `theme.set` / settings snapshot (app/src/main/client-host-ipc.ts). No IPC here.
 */

/** Effective theme Electron is actually rendering (resolves 'system'). */
export function getEffectiveTheme(): 'dark' | 'light' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** The user's stored preference ('system' = follow OS). */
export function getThemeSource(): 'system' | 'light' | 'dark' {
  return nativeTheme.themeSource as 'system' | 'light' | 'dark'
}

/**
 * Apply + persist a theme preference, returning the now-effective theme.
 *
 * Persists to the CLIENT store, not the shared database. `nativeTheme.themeSource`
 * is a property of this process, applied before the first window exists to avoid a
 * flash — so its source of truth cannot be a server that may not be running. It
 * also fixes remote mode, where this wrote to the remote hub while main read the
 * local database on the next boot, and the toggle simply did not stick.
 *
 * Called by the client host's `theme.set`; the `nativeTheme 'updated'` it causes is
 * what tells every window (main's `settings-changed`).
 */
export async function setTheme(theme: ThemePreference): Promise<'dark' | 'light'> {
  nativeTheme.themeSource = theme
  await updateClientSettings({ theme })
  return getEffectiveTheme()
}
