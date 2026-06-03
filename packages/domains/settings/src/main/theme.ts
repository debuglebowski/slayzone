import { BrowserWindow } from 'electron'
import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ThemePreference } from '../server/service'
import { settingsEvents } from '../server/events'
import { getEffectiveTheme, getThemeSource, setTheme, wireNativeThemeBridge } from './theme-core'

/**
 * The 3 `theme:*` IPC handlers + the `theme:changed` window broadcast. Both the
 * broadcast and the tRPC `settings.onThemeChanged` subscription derive from the
 * one `settingsEvents` bus (single nativeTheme listener = wireNativeThemeBridge),
 * so there is no duplicate OS listener. The renderer consumes this broadcast
 * until it moves to `settings.onThemeChanged` (slice 5), at which point this
 * whole function is deleted and only the bridge remains.
 */
export function registerThemeHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  // Defensive: the broadcast below is a no-op without the OS→bus listener. Boot
  // also wires it; idempotent so calling twice is harmless.
  wireNativeThemeBridge()

  ipcMain.handle('theme:get-effective', () => getEffectiveTheme())
  ipcMain.handle('theme:get-source', () => getThemeSource())
  ipcMain.handle('theme:set', (_, theme: ThemePreference) => setTheme(db, theme))

  settingsEvents.on('theme:changed', (effective) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('theme:changed', effective)
    })
  })
}
