import * as fs from 'node:fs'
import * as path from 'node:path'
import { invalidateIgnoreCache, isIgnored, clearIgnoreCache } from './file-ops'

export type FileWatchEvent = {
  type: 'changed' | 'deleted'
  root: string
  relPath: string
}

type Listener = (e: FileWatchEvent) => void

type WatcherEntry = {
  watcher: fs.FSWatcher | undefined
  listeners: Map<Listener, Set<symbol>>
  debounceMap: Map<string, NodeJS.Timeout>
}

const watchers = new Map<string, WatcherEntry>()

export function subscribeFileWatcher(rootPath: string, listener: Listener): () => void {
  const root = path.resolve(rootPath)
  let entry = watchers.get(root)
  if (!entry) {
    entry = { watcher: undefined, listeners: new Map(), debounceMap: new Map() }
    watchers.set(root, entry)
  }
  const owner = Symbol()
  let owners = entry.listeners.get(listener)
  if (!owners) {
    owners = new Set()
    entry.listeners.set(listener, owners)
  }
  owners.add(owner)
  if (!entry.watcher) openWatcher(root, entry)
  // Bind to the owned entry, not whichever generation later occupies this root.
  return () => unsubscribe(root, entry, listener, owner)
}

function openWatcher(root: string, entry: WatcherEntry): void {
  const { debounceMap, listeners } = entry
  try {
    const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
      if (entry.watcher !== watcher) return
      if (!filename) return
      const relPath = filename.replace(/\\/g, '/')
      if (ignoredSafely(root, relPath)) return

      if (path.basename(relPath) === '.gitignore') {
        invalidateIgnoreCache(root)
      }

      const prev = debounceMap.get(relPath)
      if (prev) clearTimeout(prev)
      debounceMap.set(
        relPath,
        setTimeout(() => {
          if (entry.watcher !== watcher) return
          debounceMap.delete(relPath)
          const abs = path.join(root, relPath)
          const exists = fs.existsSync(abs)
          const event: FileWatchEvent = {
            type: exists ? 'changed' : 'deleted',
            root,
            relPath
          }
          for (const l of listeners.keys()) l(event)
        }, 100)
      )
    })

    entry.watcher = watcher
    // Node can close the native handle on error without emitting 'close'. Keep
    // logical owners, but retire this generation so a new subscription retries.
    watcher.on('error', (err) => {
      if (entry.watcher !== watcher) return
      stopWatcher(entry)
      console.warn(`[file-editor] watcher on ${root}: ${err.message}`)
    })
    watcher.on('close', () => {
      if (entry.watcher !== watcher) return
      entry.watcher = undefined
      clearDebounce(entry)
    })
  } catch {
    // A failed constructor has no stream; retain its owners until retry/disposal.
  }
}

/**
 * `isIgnored` throws for a name the `ignore` matcher reads as non-relative (`...`,
 * `.../x`). Here that throw has no caller, so a file named `...` ended the process
 * (T-102). Such a name is a real file and simply not ignored.
 */
function ignoredSafely(root: string, relPath: string): boolean {
  try {
    return isIgnored(root, relPath, false)
  } catch {
    return false
  }
}

function clearDebounce(entry: WatcherEntry): void {
  for (const timer of entry.debounceMap.values()) clearTimeout(timer)
  entry.debounceMap.clear()
}

function stopWatcher(entry: WatcherEntry): void {
  const watcher = entry.watcher
  entry.watcher = undefined
  clearDebounce(entry)
  watcher?.close()
}

function unsubscribe(root: string, entry: WatcherEntry, listener: Listener, owner: symbol): void {
  const owners = entry.listeners.get(listener)
  if (!owners?.delete(owner)) return
  if (owners.size === 0) entry.listeners.delete(listener)
  if (entry.listeners.size === 0) {
    if (watchers.get(root) === entry) watchers.delete(root)
    stopWatcher(entry)
  }
}

export function closeAllFileWatchers(): void {
  for (const [, entry] of watchers) {
    entry.listeners.clear()
    stopWatcher(entry)
  }
  watchers.clear()
  clearIgnoreCache()
}
