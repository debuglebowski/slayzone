import { nativeTheme, BrowserWindow } from 'electron'
import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { SettingsService, type ThemePreference } from './service'

export function registerThemeHandlers(ipcMain: IpcMain, db: Database): void {
  const settings = SettingsService.forDatabase(db)

  ipcMain.handle('theme:get-effective', () => {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })

  ipcMain.handle('theme:get-source', () => {
    return nativeTheme.themeSource
  })

  ipcMain.handle('theme:set', async (_, theme: ThemePreference) => {
    nativeTheme.themeSource = theme
    await settings.setTheme(theme)
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })

  nativeTheme.on('updated', () => {
    const effective = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('theme:changed', effective)
    })
  })
}
