import * as fs from 'node:fs'
import { BrowserWindow } from 'electron'

// Global fs.watch on the assets directory. Broadcasts `assets:content-changed`
// with the assetId whenever any asset file is created/modified/removed.
//
// Drives editor re-read, image/pdf cache-bust, and any other content consumer.
// Decoupled from DB `updated_at` / `tasks:changed` so that:
//   - CLI writes, external editors (via `slay tasks assets path`), and renderer
//     saves all flow through the same channel
//   - there is no DB↔file timing race
//   - there is no channel overload with metadata changes

let watcher: fs.FSWatcher | null = null
const debounceMap = new Map<string, NodeJS.Timeout>()
const DEBOUNCE_MS = 100

// assets dir layout: <assetsDir>/<taskId>/<assetId><ext>
function extractAssetId(filename: string): string | null {
  const rel = filename.replace(/\\/g, '/')
  const parts = rel.split('/')
  if (parts.length !== 2) return null
  const file = parts[1]
  if (!file) return null
  const dot = file.indexOf('.')
  const id = dot === -1 ? file : file.slice(0, dot)
  return id || null
}

export function startAssetWatcher(assetsDir: string): void {
  if (watcher) return
  try {
    fs.mkdirSync(assetsDir, { recursive: true })
  } catch { /* ignore */ }
  try {
    watcher = fs.watch(assetsDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      const assetId = extractAssetId(filename.toString())
      if (!assetId) return
      const prev = debounceMap.get(assetId)
      if (prev) clearTimeout(prev)
      debounceMap.set(assetId, setTimeout(() => {
        debounceMap.delete(assetId)
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            w.webContents.send('assets:content-changed', assetId)
          }
        }
      }, DEBOUNCE_MS))
    })
  } catch {
    // fs.watch can fail (missing dir, unsupported fs) — silently no-op
  }
}

export function closeAssetWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
  for (const t of debounceMap.values()) clearTimeout(t)
  debounceMap.clear()
}
