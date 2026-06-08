import { nativeTheme } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import { SettingsService, type ThemePreference } from '../server/service'
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
 * Apply + persist a theme preference, returning the now-effective theme. Writes
 * through SettingsService (the warmed singleton keyed by this db) so sync
 * getCached() readers stay coherent. Shared by the `theme:set` IPC handler + the
 * `settings.setTheme` tRPC mutation.
 */
export async function setTheme(db: SlayzoneDb, theme: ThemePreference): Promise<'dark' | 'light'> {
  nativeTheme.themeSource = theme
  await SettingsService.forDatabase(db).setTheme(theme)
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
