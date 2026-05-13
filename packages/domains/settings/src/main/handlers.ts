import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { SettingsService } from './service'

export function registerSettingsHandlers(ipcMain: IpcMain, db: Database): void {
  const settings = new SettingsService(db)

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
