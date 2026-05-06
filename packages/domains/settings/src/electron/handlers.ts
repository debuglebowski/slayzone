import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { getSetting, setSetting, getAllSettings } from '../server'

export function registerSettingsHandlers(ipcMain: IpcMain, db: Database): void {

  ipcMain.handle('db:settings:get', (_, key: string) => getSetting(db, key))

  ipcMain.handle('db:settings:set', (_, key: string, value: string) => {
    setSetting(db, key, value)
  })

  ipcMain.handle('db:settings:getAll', () => getAllSettings(db))
}
