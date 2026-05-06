import * as fs from 'node:fs'
import { BrowserWindow } from 'electron'

// Global fs.watch on the artifacts directory. Broadcasts `artifacts:content-changed`
// with the artifactId whenever any artifact file is created/modified/removed.
//
// Drives editor re-read, image/pdf cache-bust, and any other content consumer.
// Decoupled from DB `updated_at` / `tasks:changed` so that:
//   - CLI writes, external editors (via `slay tasks artifacts path`), and renderer
//     saves all flow through the same channel
//   - there is no DB↔file timing race
//   - there is no channel overload with metadata changes

let watcher: fs.FSWatcher | null = null
const debounceMap = new Map<string, NodeJS.Timeout>()
const DEBOUNCE_MS = 100

// artifacts dir layout: <artifactsDir>/<taskId>/<artifactId><ext>
function extractArtifactId(filename: string): string | null {
  const rel = filename.replace(/\\/g, '/')
  const parts = rel.split('/')
  if (parts.length !== 2) return null
  const file = parts[1]
  if (!file) return null
  const dot = file.indexOf('.')
  const id = dot === -1 ? file : file.slice(0, dot)
  return id || null
}

export function startArtifactWatcher(artifactsDir: string): void {
  if (watcher) return
  try {
    fs.mkdirSync(artifactsDir, { recursive: true })
  } catch { /* ignore */ }
  try {
    watcher = fs.watch(artifactsDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      const artifactId = extractArtifactId(filename.toString())
      if (!artifactId) return
      const prev = debounceMap.get(artifactId)
      if (prev) clearTimeout(prev)
      debounceMap.set(artifactId, setTimeout(() => {
        debounceMap.delete(artifactId)
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            w.webContents.send('artifacts:content-changed', artifactId)
          }
        }
      }, DEBOUNCE_MS))
    })
  } catch {
    // fs.watch can fail (missing dir, unsupported fs) — silently no-op
  }
}

export function closeArtifactWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
  for (const t of debounceMap.values()) clearTimeout(t)
  debounceMap.clear()
}
