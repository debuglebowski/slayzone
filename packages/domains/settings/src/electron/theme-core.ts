import { nativeTheme } from 'electron'
import { type ThemePreference } from '../server/service'
import { updateClientSettings } from '@slayzone/platform/client-settings'
import { settingsEvents } from '../server/events'

/**
 * Pure theme API — `nativeTheme` only, no IPC/BrowserWindow. This is the narrow
 * surface the tRPC `settings.*Theme` procedures dynamically import (via the
 * `@slayzone/settings/theme` subpath) so transport never reaches the IPC
 * handler-registration barrel. The IPC broadcast side lives in ./theme.
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
 * Shared by the `theme:set` IPC handler + the `settings.setTheme` tRPC mutation
 * (the latter reaches here through AppDeps.themeSet, i.e. on the desktop).
 */
export async function setTheme(theme: ThemePreference): Promise<'dark' | 'light'> {
  nativeTheme.themeSource = theme
  await updateClientSettings({ theme })
  return getEffectiveTheme()
}

let bridgeInstalled = false

/**
 * The single OS→app theme listener: wires nativeTheme.on('updated') into
 * settingsEvents. Everything downstream — the tRPC `settings.onThemeChanged`
 * subscription AND the IPC `theme:changed` broadcast (registerThemeHandlers) —
 * subscribes to that bus, so there is exactly one nativeTheme listener.
 * Idempotent. Permanent (survives the slice-5 IPC removal).
 */
export function wireNativeThemeBridge(): void {
  if (bridgeInstalled) return
  bridgeInstalled = true
  nativeTheme.on('updated', () => {
    settingsEvents.emit('theme:changed', getEffectiveTheme())
  })
}
