import * as path from 'node:path'
import type { IpcMain } from 'electron'
import { BrowserWindow } from 'electron'
import type { SearchFilesOptions } from '../shared'
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
  assertWithinRoot
} from '../server/file-ops'
import { subscribeFileWatcher, closeAllFileWatchers } from '../server/watcher'

// Electron glue. All file logic lives in the electron-free server store
// (`../server`). These thin handlers exist only while IPC + tRPC coexist; the
// tRPC `fileEditor` router calls the same store. Both go away from the IPC side
// at renderer cutover (slice 5).

// Per-root, per-window bridge: forwards server-watcher events to each window's
// renderer over the legacy fs:changed / fs:deleted broadcast channels. The
// tRPC `fileEditor.watch` subscription consumes the very same server watcher.
const winSubs = new Map<string, Map<BrowserWindow, () => void>>()

export function closeAllWatchers(): void {
  for (const inner of winSubs.values()) {
    for (const unsub of inner.values()) unsub()
  }
  winSubs.clear()
  closeAllFileWatchers()
}

export function registerFileEditorHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('fs:readDir', (_event, rootPath: string, dirPath: string) =>
    readDir(rootPath, dirPath)
  )

  ipcMain.handle('fs:readFile', (_event, rootPath: string, filePath: string, force?: boolean) =>
    readFile(rootPath, filePath, force)
  )

  ipcMain.handle('fs:listAllFiles', (_event, rootPath: string) => listAllFiles(rootPath))

  ipcMain.handle('fs:watch', (event, rootPath: string) => {
    const root = path.resolve(rootPath)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    const existing = winSubs.get(root)
    if (existing?.has(win)) return
    const inner = existing ?? new Map<BrowserWindow, () => void>()
    if (!existing) winSubs.set(root, inner)

    const unsub = subscribeFileWatcher(root, (e) => {
      if (win.isDestroyed()) return
      win.webContents.send(e.type === 'changed' ? 'fs:changed' : 'fs:deleted', e.root, e.relPath)
    })
    inner.set(win, unsub)
    win.once('closed', () => {
      unsub()
      inner.delete(win)
      if (inner.size === 0) winSubs.delete(root)
    })
  })

  ipcMain.handle('fs:unwatch', (event, rootPath: string) => {
    const root = path.resolve(rootPath)
    const inner = winSubs.get(root)
    if (!inner) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const unsub = inner.get(win)
    if (unsub) {
      unsub()
      inner.delete(win)
    }
    if (inner.size === 0) winSubs.delete(root)
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

  ipcMain.handle(
    'fs:copyIn',
    (_event, rootPath: string, absoluteSrc: string, targetDir?: string) =>
      copyIn(rootPath, absoluteSrc, targetDir)
  )

  ipcMain.handle('fs:copy', (_event, rootPath: string, srcPath: string, destPath: string) => {
    copy(rootPath, srcPath, destPath)
  })

  ipcMain.handle('fs:showInFinder', (_event, rootPath: string, targetPath: string) => {
    const abs = targetPath ? assertWithinRoot(rootPath, targetPath) : path.resolve(rootPath)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as typeof import('electron')
    shell.showItemInFolder(abs)
  })

  ipcMain.handle('fs:gitStatus', (_event, rootPath: string) => gitStatus(rootPath))

  ipcMain.handle(
    'fs:searchFiles',
    (_event, rootPath: string, query: string, options?: SearchFilesOptions) =>
      searchFiles(rootPath, query, options)
  )
}
