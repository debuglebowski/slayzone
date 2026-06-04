import * as fs from 'node:fs'
import { EventEmitter } from 'node:events'

// Global fs.watch on the artifacts directory. Emits `content-changed` with the
// artifactId whenever any artifact file is created/modified/removed.
//
// Drives editor re-read, image/pdf cache-bust, and any other content consumer.
// Decoupled from DB `updated_at` / `tasks:changed` so that:
//   - CLI writes, external editors (via `slay tasks artifacts path`), and renderer
//     saves all flow through the same channel
//   - there is no DB↔file timing race
//   - there is no channel overload with metadata changes
//
// Electron-free: the Electron-main host bridges these events to renderer windows
// (`artifacts:content-changed` IPC) in `../main/artifact-watcher.ts`, and the
// transport `artifacts.onContentChanged` tRPC subscription bridges them to WS
// clients — both subscribe to the same emitter.

export interface ArtifactWatcherEventMap {
  'content-changed': string
}

class TypedEmitter<M> extends EventEmitter {
  override emit<K extends keyof M & string>(event: K, payload: M[K]): boolean {
    return super.emit(event, payload)
  }
  override on<K extends keyof M & string>(event: K, listener: (payload: M[K]) => void): this {
    return super.on(event, listener)
  }
  override off<K extends keyof M & string>(event: K, listener: (payload: M[K]) => void): this {
    return super.off(event, listener)
  }
}

export const artifactWatcherEvents = new TypedEmitter<ArtifactWatcherEventMap>()

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
  } catch {
    /* ignore */
  }
  try {
    watcher = fs.watch(artifactsDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      const artifactId = extractArtifactId(filename.toString())
      if (!artifactId) return
      const prev = debounceMap.get(artifactId)
      if (prev) clearTimeout(prev)
      debounceMap.set(
        artifactId,
        setTimeout(() => {
          debounceMap.delete(artifactId)
          artifactWatcherEvents.emit('content-changed', artifactId)
        }, DEBOUNCE_MS)
      )
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
