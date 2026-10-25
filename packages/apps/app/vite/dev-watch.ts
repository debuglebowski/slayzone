// Dev-server file watching for the renderer (`vite serve` only).
//
// Why: Vite's watcher (chokidar on macOS FSEvents) adds the env files
// (`<envDir>/.env*`) to its watch list. envDir is the REPO ROOT, so chokidar
// opens — and, via its "consolidate under a common parent" rule, funnels every
// other watched file onto — ONE FSEvents stream rooted at the repo. Every write
// anywhere in the repo (electron-vite build → out/, e2e runtimes, .claude
// worktrees, other agents' builds, git) then runs one JS listener per watched
// file (~1400) on Vite's main thread. Under parallel agent load that pinned the
// dev server at 100% CPU and it stopped serving the renderer.
//
// Fix: keep the env files out of chokidar (`ignored`), so its streams stay
// rooted at the directories that actually hold renderer/workspace sources, and
// watch the env files here with a plain non-recursive fs.watch on envDir
// (filtered natively) — preserving Vite's "env file changed → restart server".
// The extra `ignored` globs are build/test output the renderer never imports.
import { createHash } from 'node:crypto'
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

/** The env files Vite loads (and watches) for `mode` — same list as Vite's getEnvFilesForMode. */
export function envFileNames(mode: string): string[] {
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
}

/** chokidar `ignored` entries for the renderer dev server. */
export function devWatchIgnored(envDir: string, mode: string): string[] {
  return [
    ...envFileNames(mode).map((f) => join(envDir, f)),
    '**/out/**',
    '**/dist/**',
    '**/.e2e-runtime/**',
    '**/test-results/**',
    '**/playwright-report/**',
    '**/coverage/**',
    '**/.claude/**',
    '**/*.sqlite*',
    '**/*.db',
    '**/*.db-wal',
    '**/*.db-shm'
  ]
}

/** Restart the dev server when an env file changes (Vite's own env watch is ignored above). */
export function envFilesRestartPlugin(envDir: string): Plugin {
  return {
    name: 'slayzone:env-files-restart',
    apply: 'serve',
    configureServer(server) {
      const names = envFileNames(server.config.mode)
      // Content fingerprint of all env files: one save fires several FS events
      // (and touch/no-op writes fire some too) — restart only on a real change.
      const fingerprint = (): string => {
        const h = createHash('sha256')
        for (const n of names) {
          let body = '\0missing'
          try {
            body = readFileSync(join(envDir, n), 'utf8')
          } catch {
            /* absent */
          }
          h.update(n).update('\0').update(body).update('\0')
        }
        return h.digest('hex')
      }
      let last = fingerprint()
      let timer: NodeJS.Timeout | undefined
      let watcher: FSWatcher | undefined
      try {
        watcher = watch(envDir, (_event, filename) => {
          if (!filename || !names.includes(filename.toString())) return
          // Trailing debounce: a burst of events for one save = one check.
          clearTimeout(timer)
          timer = setTimeout(() => {
            const next = fingerprint()
            if (next === last) return
            last = next
            server.config.logger.info(`${filename} changed, restarting server...`, {
              clear: true,
              timestamp: true
            })
            void server.restart()
          }, 250)
        })
        watcher.on('error', () => watcher?.close())
      } catch {
        // envDir unreadable: nothing to watch (Vite would not load env from it either).
      }
      server.httpServer?.once('close', () => {
        clearTimeout(timer)
        watcher?.close()
      })
    }
  }
}
