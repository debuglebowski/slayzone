import { nativeTheme, BrowserWindow } from 'electron'
import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import { SettingsService, type ThemePreference } from '../server/service'
import { settingsEvents } from '../server/events'

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
 * Wire nativeTheme OS-level events into settingsEvents so the tRPC
 * `settings.onThemeChanged` subscription fires on dark/light toggles. Idempotent.
 * Runs alongside registerThemeHandlers' IPC broadcast (dual-emit) until the
 * renderer drops IPC (slice 5).
 */
export function wireNativeThemeBridge(): void {
  if (bridgeInstalled) return
  bridgeInstalled = true
  nativeTheme.on('updated', () => {
    settingsEvents.emit('theme:changed', getEffectiveTheme())
  })
}

export function registerThemeHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  ipcMain.handle('theme:get-effective', () => getEffectiveTheme())
  ipcMain.handle('theme:get-source', () => getThemeSource())
  ipcMain.handle('theme:set', (_, theme: ThemePreference) => setTheme(db, theme))

  nativeTheme.on('updated', () => {
    const effective = getEffectiveTheme()
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('theme:changed', effective)
    })
  })
}
