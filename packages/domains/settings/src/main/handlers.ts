import type { IpcMain } from 'electron'
import type { SettingsService } from './service'

// Takes the app's shared SettingsService rather than minting its own. A separate
// instance would write to SQLite but never touch the warmed cache that sync
// getCached() readers (e.g. the idle-close sweep) rely on, so UI changes to
// pre-warmed keys would silently never propagate until restart.
export function registerSettingsHandlers(ipcMain: IpcMain, settings: SettingsService): void {
  ipcMain.handle('db:settings:get', async (_, key: string) => {
    return (await settings.get(key)) ?? null
  })

  ipcMain.handle('db:settings:set', async (_, key: string, value: string) => {
    await settings.set(key, value)
  })

  ipcMain.handle('db:settings:getAll', async () => {
    return await settings.getAll()
  })
}
