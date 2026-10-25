// Dev watch for the esbuild-bundled Node sidecars (hub, computer): rebuild when
// any file that went INTO the last bundle changes — the bundle's own src/ AND
// every workspace package it inlines (packages/domains/*/src/server, shared/*, …).
//
// Driven by the build's metafile: after each build, call `update(metafile)` and
// the watcher re-targets to exactly the directories holding non-node_modules
// inputs (one non-recursive fs.watch per directory — no recursive walk over
// node_modules trees, which on Linux means an inotify watch per directory).
// A newly added file only matters once an existing input imports it; that edit
// triggers the rebuild and the next `update` picks the new file up.
//
// Before the first successful build there is no metafile (the code doesn't
// build yet); `update(null)` then watches `fallbackDir` recursively — any change
// there retries the build — until a build succeeds and real inputs take over.
import { existsSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const NODE_MODULES_RE = /[\\/]node_modules[\\/]/

/**
 * @param {{ onChange: (file: string) => void, fallbackDir: string, debounceMs?: number }} opts
 * @returns {{ update(metafile: { inputs: Record<string, unknown> } | null, absWorkingDir?: string): void, close(): void }}
 */
export function watchBundleInputs({ onChange, fallbackDir, debounceMs = 150 }) {
  /** @type {Set<string>} */
  let inputs = new Set()
  /** @type {Map<string, import('node:fs').FSWatcher>} */
  const watchers = new Map()
  /** @type {NodeJS.Timeout | undefined} */
  let timer

  const fire = (file) => {
    clearTimeout(timer)
    timer = setTimeout(() => onChange(file), debounceMs)
  }

  /** @type {import('node:fs').FSWatcher | undefined} */
  let fallback

  return {
    update(metafile, absWorkingDir = process.cwd()) {
      if (!metafile) {
        if (watchers.size > 0) return // keep the last good build's inputs
        fallback ??= watch(fallbackDir, { recursive: true }, (_event, filename) => {
          if (filename) fire(join(fallbackDir, filename.toString()))
        })
        return
      }
      fallback?.close()
      fallback = undefined
      inputs = new Set(
        Object.keys(metafile.inputs)
          // Plugin-loaded inputs carry their namespace ("raw-import:/abs/file.sh");
          // strip it (a single letter is a Windows drive, not a namespace).
          .map((p) => {
            const m = /^([a-z][a-z0-9-]+):(.+)$/i.exec(p)
            return m ? m[2] : p
          })
          .map((p) => resolve(absWorkingDir, p))
          .filter((p) => !NODE_MODULES_RE.test(p) && existsSync(p))
      )
      const dirs = new Set([...inputs].map((p) => dirname(p)))
      for (const [dir, w] of watchers) {
        if (!dirs.has(dir)) {
          w.close()
          watchers.delete(dir)
        }
      }
      for (const dir of dirs) {
        if (watchers.has(dir)) continue
        try {
          const w = watch(dir, (_event, filename) => {
            if (!filename) return
            const file = join(dir, filename.toString())
            if (inputs.has(file)) fire(file)
          })
          w.on('error', () => {
            w.close()
            watchers.delete(dir)
          })
          watchers.set(dir, w)
        } catch {
          // Directory vanished between build and watch; the next build re-targets.
        }
      }
    },
    close() {
      clearTimeout(timer)
      fallback?.close()
      for (const w of watchers.values()) w.close()
      watchers.clear()
    }
  }
}
