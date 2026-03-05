import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IpcMain } from 'electron'
import { BrowserWindow } from 'electron'
import ignore from 'ignore'
import type { DirEntry, ReadFileResult, FileSearchResult, FileSearchMatch, SearchFilesOptions } from '../shared'

const ALWAYS_IGNORED = new Set(['.git', '.DS_Store'])

const MAX_FILE_SIZE = 1 * 1024 * 1024 // 1 MB
const FORCE_MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

function assertWithinRoot(root: string, target: string): string {
  const resolved = path.resolve(root, target)
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    throw new Error('Path traversal denied')
  }
  return resolved
}

// .gitignore cache keyed by resolved root path
const ignoreCache = new Map<string, { ig: ReturnType<typeof ignore>; mtime: number }>()

function getIgnoreFilter(rootPath: string): ReturnType<typeof ignore> {
  const root = path.resolve(rootPath)
  const gitignorePath = path.join(root, '.gitignore')
  let mtime = 0
  try { mtime = fs.statSync(gitignorePath).mtimeMs } catch { /* no .gitignore */ }

  const cached = ignoreCache.get(root)
  if (cached && cached.mtime === mtime) return cached.ig

  const ig = ignore()
  try {
    ig.add(fs.readFileSync(gitignorePath, 'utf-8'))
  } catch { /* no .gitignore */ }
  ignoreCache.set(root, { ig, mtime })
  return ig
}

export function invalidateIgnoreCache(rootPath: string): void {
  ignoreCache.delete(path.resolve(rootPath))
}

function isIgnored(rootPath: string, relativePath: string, isDir: boolean): boolean {
  if (ALWAYS_IGNORED.has(path.basename(relativePath))) return true
  const ig = getIgnoreFilter(rootPath)
  return ig.ignores(isDir ? relativePath + '/' : relativePath)
}

// File watcher management
const watchers = new Map<string, { watcher: fs.FSWatcher; wins: Set<BrowserWindow>; debounceMap: Map<string, NodeJS.Timeout> }>()

function cleanupWatcherEntry(root: string): void {
  const entry = watchers.get(root)
  if (!entry || entry.wins.size > 0) return
  entry.watcher.close()
  for (const t of entry.debounceMap.values()) clearTimeout(t)
  watchers.delete(root)
}

function addWinToWatcher(root: string, win: BrowserWindow, wins: Set<BrowserWindow>): void {
  if (wins.has(win)) return
  wins.add(win)
  win.once('closed', () => {
    wins.delete(win)
    cleanupWatcherEntry(root)
  })
}

export function registerFileEditorHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('fs:readDir', (_event, rootPath: string, dirPath: string): DirEntry[] => {
    const abs = dirPath ? assertWithinRoot(rootPath, dirPath) : path.resolve(rootPath)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch (error) {
      // File trees can request folders that were just moved/deleted. Treat as empty
      // so the renderer can recover without surfacing noisy IPC errors.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter((e) => !ALWAYS_IGNORED.has(e.name))
      .map((e) => {
        const relPath = dirPath ? `${dirPath}/${e.name}` : e.name
        const ignored = isIgnored(rootPath, relPath, e.isDirectory())
        return {
          name: e.name,
          path: relPath,
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
          ...(ignored && { ignored: true })
        }
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  })

  ipcMain.handle('fs:readFile', (_event, rootPath: string, filePath: string, force?: boolean): ReadFileResult => {
    const abs = assertWithinRoot(rootPath, filePath)
    const stat = fs.statSync(abs)
    if (stat.size > FORCE_MAX_FILE_SIZE) {
      return { content: null, tooLarge: true, sizeBytes: stat.size }
    }
    if (!force && stat.size > MAX_FILE_SIZE) {
      return { content: null, tooLarge: true, sizeBytes: stat.size }
    }
    return { content: fs.readFileSync(abs, 'utf-8') }
  })

  ipcMain.handle('fs:listAllFiles', (_event, rootPath: string): string[] => {
    const root = path.resolve(rootPath)
    const ig = getIgnoreFilter(rootPath)
    const results: string[] = []

    function walk(dir: string, prefix: string): void {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const relPath = prefix ? `${prefix}/${e.name}` : e.name
        if (ALWAYS_IGNORED.has(e.name)) continue
        if (ig.ignores(e.isDirectory() ? relPath + '/' : relPath)) continue
        if (e.isDirectory()) {
          walk(path.join(dir, e.name), relPath)
        } else {
          results.push(relPath)
        }
      }
    }

    walk(root, '')
    return results
  })

  ipcMain.handle('fs:watch', (event, rootPath: string) => {
    const root = path.resolve(rootPath)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    const existing = watchers.get(root)
    if (existing) {
      addWinToWatcher(root, win, existing.wins)
      return
    }

    const debounceMap = new Map<string, NodeJS.Timeout>()
    const wins = new Set<BrowserWindow>()

    try {
      const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        const relPath = filename.replace(/\\/g, '/')
        if (isIgnored(root, relPath, false)) return

        // Invalidate .gitignore cache when .gitignore itself changes
        if (path.basename(relPath) === '.gitignore') {
          invalidateIgnoreCache(root)
        }

        const prev = debounceMap.get(relPath)
        if (prev) clearTimeout(prev)
        debounceMap.set(relPath, setTimeout(() => {
          debounceMap.delete(relPath)
          for (const w of wins) {
            if (!w.isDestroyed()) {
              w.webContents.send('fs:changed', root, relPath)
            }
          }
        }, 100))
      })

      watchers.set(root, { watcher, wins, debounceMap })
      addWinToWatcher(root, win, wins)
    } catch {
      // fs.watch can fail if path doesn't exist
    }
  })

  ipcMain.handle('fs:unwatch', (event, rootPath: string) => {
    const root = path.resolve(rootPath)
    const entry = watchers.get(root)
    if (!entry) return

    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) entry.wins.delete(win)
    cleanupWatcherEntry(root)
  })

  ipcMain.handle('fs:writeFile', (_event, rootPath: string, filePath: string, content: string): void => {
    const abs = assertWithinRoot(rootPath, filePath)
    fs.writeFileSync(abs, content, 'utf-8')
  })

  ipcMain.handle('fs:createFile', (_event, rootPath: string, filePath: string): void => {
    const abs = assertWithinRoot(rootPath, filePath)
    if (fs.existsSync(abs)) throw new Error('File already exists')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, '', 'utf-8')
  })

  ipcMain.handle('fs:createDir', (_event, rootPath: string, dirPath: string): void => {
    const abs = assertWithinRoot(rootPath, dirPath)
    fs.mkdirSync(abs, { recursive: true })
  })

  ipcMain.handle('fs:rename', (_event, rootPath: string, oldPath: string, newPath: string): void => {
    const absOld = assertWithinRoot(rootPath, oldPath)
    const absNew = assertWithinRoot(rootPath, newPath)
    if (fs.existsSync(absNew)) throw new Error('Target already exists')
    fs.renameSync(absOld, absNew)
  })

  ipcMain.handle('fs:delete', (_event, rootPath: string, targetPath: string): void => {
    const abs = assertWithinRoot(rootPath, targetPath)
    fs.rmSync(abs, { recursive: true })
  })

  ipcMain.handle('fs:copyIn', (_event, rootPath: string, absoluteSrc: string): string => {
    const srcResolved = path.resolve(absoluteSrc)
    if (!fs.existsSync(srcResolved) || !fs.statSync(srcResolved).isFile()) {
      throw new Error('Source is not a file')
    }
    const ext = path.extname(srcResolved)
    const name = path.basename(srcResolved, ext)
    let relPath = path.basename(srcResolved)
    let dest = assertWithinRoot(rootPath, relPath)
    let i = 1
    while (fs.existsSync(dest)) {
      relPath = `${name} (${i})${ext}`
      dest = assertWithinRoot(rootPath, relPath)
      i++
    }
    fs.copyFileSync(srcResolved, dest)
    return relPath
  })

  ipcMain.handle('fs:searchFiles', (_event, rootPath: string, query: string, options?: SearchFilesOptions): FileSearchResult[] => {
    if (!query) return []
    const root = path.resolve(rootPath)
    const ig = getIgnoreFilter(rootPath)
    const matchCase = options?.matchCase ?? false
    const useRegex = options?.regex ?? false
    const maxResults = options?.maxResults ?? 500
    let totalMatches = 0

    let pattern: RegExp
    try {
      const flags = matchCase ? 'g' : 'gi'
      pattern = useRegex ? new RegExp(query, flags) : new RegExp(escapeRegExp(query), flags)
    } catch {
      return []
    }

    const results: FileSearchResult[] = []

    function walk(dir: string, prefix: string): void {
      if (totalMatches >= maxResults) return
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (totalMatches >= maxResults) return
        const relPath = prefix ? `${prefix}/${e.name}` : e.name
        if (ALWAYS_IGNORED.has(e.name)) continue
        if (ig.ignores(e.isDirectory() ? relPath + '/' : relPath)) continue
        if (e.isDirectory()) {
          walk(path.join(dir, e.name), relPath)
        } else {
          searchFile(root, relPath, pattern, results)
        }
      }
    }

    function searchFile(rootDir: string, relPath: string, re: RegExp, out: FileSearchResult[]): void {
      if (totalMatches >= maxResults) return
      const abs = path.join(rootDir, relPath)
      let stat: fs.Stats
      try { stat = fs.statSync(abs) } catch { return }
      if (stat.size > MAX_FILE_SIZE) return

      let content: string
      try { content = fs.readFileSync(abs, 'utf-8') } catch { return }

      // Skip binary files (null bytes in first 8KB)
      if (content.slice(0, 8192).includes('\0')) return

      const matches: FileSearchMatch[] = []
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (totalMatches >= maxResults) break
        re.lastIndex = 0
        const m = re.exec(lines[i])
        if (m) {
          matches.push({ line: i + 1, col: m.index, lineText: lines[i].slice(0, 500) })
          totalMatches++
        }
      }
      if (matches.length > 0) {
        out.push({ path: relPath, matches })
      }
    }

    walk(root, '')
    return results
  })
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
