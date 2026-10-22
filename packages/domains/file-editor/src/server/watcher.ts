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
  watcher: fs.FSWatcher
  listeners: Set<Listener>
  debounceMap: Map<string, NodeJS.Timeout>
}

const watchers = new Map<string, WatcherEntry>()

export function subscribeFileWatcher(rootPath: string, listener: Listener): () => void {
  const root = path.resolve(rootPath)
  const existing = watchers.get(root)
  if (existing) {
    existing.listeners.add(listener)
    return () => unsubscribe(root, listener)
  }

  const debounceMap = new Map<string, NodeJS.Timeout>()
  const listeners = new Set<Listener>([listener])

  try {
    const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
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
          debounceMap.delete(relPath)
          const abs = path.join(root, relPath)
          const exists = fs.existsSync(abs)
          const event: FileWatchEvent = {
            type: exists ? 'changed' : 'deleted',
            root,
            relPath
          }
          for (const l of listeners) l(event)
        }, 100)
      )
    })

    // An 'error' with no listener throws out of this process (a watched root that went
    // away, out of watches). Log it; the stream simply stops reporting.
    watcher.on('error', (err) => {
      console.warn(`[file-editor] watcher on ${root}: ${err.message}`)
    })

    watchers.set(root, { watcher, listeners, debounceMap })
    return () => unsubscribe(root, listener)
  } catch {
    return () => {
      /* watch failed; nothing to unsubscribe */
    }
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

function unsubscribe(root: string, listener: Listener): void {
  const entry = watchers.get(root)
  if (!entry) return
  entry.listeners.delete(listener)
  if (entry.listeners.size === 0) {
    entry.watcher.close()
    for (const t of entry.debounceMap.values()) clearTimeout(t)
    watchers.delete(root)
  }
}

export function closeAllFileWatchers(): void {
  for (const [, entry] of watchers) {
    entry.watcher.close()
    for (const t of entry.debounceMap.values()) clearTimeout(t)
  }
  watchers.clear()
  clearIgnoreCache()
}
