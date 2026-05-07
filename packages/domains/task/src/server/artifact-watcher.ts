import * as fs from 'node:fs'
import { EventEmitter } from 'node:events'

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
  } catch { /* already exists */ }
  try {
    watcher = fs.watch(artifactsDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      const artifactId = extractArtifactId(filename.toString())
      if (!artifactId) return
      const prev = debounceMap.get(artifactId)
      if (prev) clearTimeout(prev)
      debounceMap.set(artifactId, setTimeout(() => {
        debounceMap.delete(artifactId)
        artifactWatcherEvents.emit('content-changed', artifactId)
      }, DEBOUNCE_MS))
    })
  } catch { /* watch failed */ }
}

export function closeArtifactWatcher(): void {
  if (watcher) { watcher.close(); watcher = null }
  for (const t of debounceMap.values()) clearTimeout(t)
  debounceMap.clear()
}
