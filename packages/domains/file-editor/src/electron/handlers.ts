import * as path from 'node:path'
import type { IpcMain } from 'electron'
import { BrowserWindow, shell } from 'electron'
import {
  readDir,
  readFile,
  listAllFiles,
  writeFile,
  createFile,
  createDir,
  renamePath,
  deletePath,
  copyIn,
  copy,
  gitStatus,
  searchFiles,
  assertWithinRoot,
  subscribeFileWatcher,
  closeAllFileWatchers,
} from '../server'

// Per-window watcher subscriptions: lookup unsubscribe fn by (root, win)
const winSubs = new Map<string, Map<BrowserWindow, () => void>>()

export function closeAllWatchers(): void {
  for (const [, subs] of winSubs) {
    for (const unsub of subs.values()) unsub()
  }
  winSubs.clear()
  closeAllFileWatchers()
}

export function registerFileEditorHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('fs:readDir', (_event, rootPath: string, dirPath: string) => readDir(rootPath, dirPath))

  ipcMain.handle('fs:readFile', (_event, rootPath: string, filePath: string, force?: boolean) =>
    readFile(rootPath, filePath, force))

  ipcMain.handle('fs:listAllFiles', (_event, rootPath: string) => listAllFiles(rootPath))

  ipcMain.handle('fs:watch', (event, rootPath: string) => {
    const root = path.resolve(rootPath)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    let subs = winSubs.get(root)
    if (!subs) {
      subs = new Map()
      winSubs.set(root, subs)
    }
    if (subs.has(win)) return

    const unsubscribe = subscribeFileWatcher(root, (e) => {
      if (win.isDestroyed()) return
      const channel = e.type === 'changed' ? 'fs:changed' : 'fs:deleted'
      win.webContents.send(channel, e.root, e.relPath)
    })
    subs.set(win, unsubscribe)

    win.once('closed', () => {
      const entry = winSubs.get(root)
      const unsub = entry?.get(win)
      if (unsub) unsub()
      entry?.delete(win)
      if (entry && entry.size === 0) winSubs.delete(root)
    })
  })

  ipcMain.handle('fs:unwatch', (event, rootPath: string) => {
    const root = path.resolve(rootPath)
    const entry = winSubs.get(root)
    if (!entry) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const unsub = entry.get(win)
    if (unsub) unsub()
    entry.delete(win)
    if (entry.size === 0) winSubs.delete(root)
  })

  ipcMain.handle('fs:writeFile', (_event, rootPath: string, filePath: string, content: string) => {
    writeFile(rootPath, filePath, content)
  })

  ipcMain.handle('fs:createFile', (_event, rootPath: string, filePath: string) => {
    createFile(rootPath, filePath)
  })

  ipcMain.handle('fs:createDir', (_event, rootPath: string, dirPath: string) => {
    createDir(rootPath, dirPath)
  })

  ipcMain.handle('fs:rename', (_event, rootPath: string, oldPath: string, newPath: string) => {
    renamePath(rootPath, oldPath, newPath)
  })

  ipcMain.handle('fs:delete', (_event, rootPath: string, targetPath: string) => {
    deletePath(rootPath, targetPath)
  })

  ipcMain.handle('fs:copyIn', (_event, rootPath: string, absoluteSrc: string, targetDir?: string) =>
    copyIn(rootPath, absoluteSrc, targetDir))

  ipcMain.handle('fs:copy', (_event, rootPath: string, srcPath: string, destPath: string) => {
    copy(rootPath, srcPath, destPath)
  })

  ipcMain.handle('fs:showInFinder', (_event, rootPath: string, targetPath: string) => {
    const abs = targetPath ? assertWithinRoot(rootPath, targetPath) : path.resolve(rootPath)
    shell.showItemInFolder(abs)
  })

  ipcMain.handle('fs:gitStatus', (_event, rootPath: string) => gitStatus(rootPath))

  ipcMain.handle('fs:searchFiles', (_event, rootPath: string, query: string, options?: Parameters<typeof searchFiles>[2]) =>
    searchFiles(rootPath, query, options))
}
