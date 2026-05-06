/**
 * GitWatcher — refcounted fs watchers for git worktrees. Emits `git:diff-changed`
 * when relevant state (index, HEAD, refs, or tracked working-tree files)
 * changes. Replaces the renderer's 5s polling with push-based invalidation.
 *
 * Implementation notes:
 *   - Uses Node's built-in `fs.watch(dir, { recursive: true })` — no chokidar
 *     dep needed (matches the existing file-editor watcher pattern).
 *   - Watches the worktree tree AND the `.git` dir (index / HEAD / refs/heads).
 *     Note: when `.git` is a file (worktree linked dir), we watch the real
 *     `gitdir` path that the file points at.
 *   - Debounces ALL events per-path into a single emission every 200ms.
 *   - Excludes hot, irrelevant paths via a simple substring filter (node_modules,
 *     dist, build, coverage, .e2e-userdata, .git/objects, .git/logs). The first
 *     path segment is checked against a Set — cheap and covers 99% of write
 *     noise during git operations.
 *   - Refcounts watchers by worktreePath. Last unsubscribe closes the watcher.
 *   - On ENOSPC (Linux inotify exhaustion) or any watcher error, the watcher
 *     detaches cleanly — renderer falls back to its poll timer.
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'

const DEBOUNCE_MS = 200

// First-segment exclusions (fast — split path once, check Set).
const EXCLUDED_TOP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.e2e-userdata',
  '.next',
  '.turbo',
  '.cache',
  'out',
])

// Paths relative to the worktree root whose deepest segments we care about.
// `.git/objects` and `.git/logs` are noisy; we explicitly exclude them below.
const EXCLUDED_GIT_SUBDIRS = new Set(['objects', 'logs'])

export interface GitWatcherEvents {
  'git:diff-changed': (payload: { worktreePath: string }) => void
  /**
   * Emitted when a watcher tears down due to an error (ENOSPC, worktree
   * deletion, platform quirk). Renderer listens and tightens its poll
   * cadence — without this it would stay pinned at WATCHER_FALLBACK_POLL_MS
   * (30s) forever, since `watchStart` already resolved successfully.
   */
  'git:diff-watch-failed': (payload: { worktreePath: string }) => void
}

export interface GitWatcher extends EventEmitter {
  subscribe(worktreePath: string): void
  unsubscribe(worktreePath: string): void
  /** Stop all watchers (called on app quit). */
  closeAll(): void
  /** Test / diagnostic. */
  _activePaths(): string[]
}

interface WatchEntry {
  worktreePath: string
  refCount: number
  /** Active fs.FSWatcher instances — one per watched root (worktree + .git gitdir). */
  watchers: fs.FSWatcher[]
  debounceTimer: NodeJS.Timeout | null
  closed: boolean
}

let enospcWarned = false

function isExcludedPath(relPath: string): boolean {
  // `.git/objects/...` and `.git/logs/...` are hot during any git op — skip.
  const parts = relPath.split(/[\\/]/)
  if (parts[0] === '.git' && parts.length > 1 && EXCLUDED_GIT_SUBDIRS.has(parts[1])) {
    return true
  }
  if (EXCLUDED_TOP_DIRS.has(parts[0])) return true
  // Nested exclusions — e.g. `packages/foo/node_modules/...`
  for (const p of parts) {
    if (EXCLUDED_TOP_DIRS.has(p)) return true
  }
  return false
}

/**
 * Resolve the canonical `.git` dir for a worktree. For linked worktrees,
 * `.git` is a file containing `gitdir: /path/to/real/gitdir`. For the main
 * checkout, `.git` is itself a directory.
 */
function resolveGitDir(worktreePath: string): string | null {
  const dotGit = path.join(worktreePath, '.git')
  let stat: fs.Stats
  try {
    stat = fs.statSync(dotGit)
  } catch {
    return null
  }
  if (stat.isDirectory()) return dotGit
  if (!stat.isFile()) return null
  try {
    const content = fs.readFileSync(dotGit, 'utf-8').trim()
    const match = content.match(/^gitdir:\s*(.+)$/)
    if (!match) return null
    const gitdir = match[1].trim()
    return path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreePath, gitdir)
  } catch {
    return null
  }
}

export function createGitWatcher(): GitWatcher {
  const entries = new Map<string, WatchEntry>()
  const emitter = new EventEmitter() as GitWatcher

  function scheduleEmit(entry: WatchEntry): void {
    if (entry.debounceTimer) return
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      if (entry.closed) return
      emitter.emit('git:diff-changed', { worktreePath: entry.worktreePath })
    }, DEBOUNCE_MS)
  }

  function teardown(entry: WatchEntry): void {
    if (entry.closed) return
    entry.closed = true
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    for (const w of entry.watchers) {
      try { w.close() } catch { /* best-effort */ }
    }
    entry.watchers = []
  }

  function openWatcher(entry: WatchEntry, root: string, isGitDir: boolean): void {
    try {
      // `recursive: true` is safe on all three target platforms:
      //   - macOS: supported since Node 7 (FSEvents backend)
      //   - Windows: supported since Node 7 (ReadDirectoryChangesW)
      //   - Linux: supported natively since Node 20 (inotify walk)
      // Electron 41 bundles Node 22.x, so we never hit the pre-Node-20 Linux
      // silent-no-op path. If the Electron baseline ever drops below Node 20,
      // add a Linux guard here that falls back to watching .git/{index,HEAD,refs/heads}
      // non-recursively.
      const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
        if (entry.closed) return
        if (!filename) {
          // Filename is unavailable on some platforms for coalesced events —
          // still treat as a change signal.
          scheduleEmit(entry)
          return
        }
        const rel: string = typeof filename === 'string' ? filename : String(filename)
        if (!isGitDir) {
          // Working tree watcher — filter noise.
          if (isExcludedPath(rel)) return
        } else {
          // .git watcher — ignore objects/logs subtrees.
          const parts = rel.split(/[\\/]/)
          if (EXCLUDED_GIT_SUBDIRS.has(parts[0])) return
        }
        scheduleEmit(entry)
      })

      watcher.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOSPC' && !enospcWarned) {
          enospcWarned = true
          console.warn(
            '[git-watcher] ENOSPC — inotify watch limit hit, git push-updates disabled (polling fallback active). ' +
              'Raise with: echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p'
          )
        } else if (err.code !== 'ENOSPC') {
          console.warn(`[git-watcher] watcher error on ${root}:`, err.message)
        }
        // Detach on error. Next subscribe() recreates.
        teardown(entry)
        entries.delete(entry.worktreePath)
        // Notify renderer(s) so they can drop `watcherActive` and retighten
        // their poll cadence. Fire AFTER teardown so any late 'close' event
        // from fs.watch is already drained.
        try {
          emitter.emit('git:diff-watch-failed', { worktreePath: entry.worktreePath })
        } catch {
          /* listener threw — never crash the watcher */
        }
      })

      entry.watchers.push(watcher)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOSPC' && !enospcWarned) {
        enospcWarned = true
        console.warn('[git-watcher] ENOSPC on open — inotify exhausted; poll fallback only')
      } else if (code !== 'ENOENT') {
        console.warn(`[git-watcher] failed to watch ${root}:`, err)
      }
      // Don't throw — partial watch is still useful. If both fail the renderer
      // falls back to poll.
    }
  }

  emitter.subscribe = (worktreePath: string): void => {
    let entry = entries.get(worktreePath)
    if (entry) {
      entry.refCount++
      return
    }
    entry = {
      worktreePath,
      refCount: 1,
      watchers: [],
      debounceTimer: null,
      closed: false,
    }
    entries.set(worktreePath, entry)

    // Watch the worktree tree itself (recursive).
    openWatcher(entry, worktreePath, false)

    // Watch the resolved gitdir. On linked worktrees this is outside the
    // worktree tree so the above recursive watch doesn't see it.
    const gitdir = resolveGitDir(worktreePath)
    if (gitdir) {
      openWatcher(entry, gitdir, true)
    }

    // If no watchers opened successfully, roll the entry back — renderer
    // treats watchStart failure as "poll only" mode via the preload promise.
    if (entry.watchers.length === 0) {
      entries.delete(worktreePath)
      entry.closed = true
      throw new Error('git-watcher: no watchers opened (path missing or inotify limit)')
    }
  }

  emitter.unsubscribe = (worktreePath: string): void => {
    const entry = entries.get(worktreePath)
    if (!entry) return
    entry.refCount--
    if (entry.refCount > 0) return
    teardown(entry)
    entries.delete(worktreePath)
  }

  emitter.closeAll = (): void => {
    for (const entry of entries.values()) teardown(entry)
    entries.clear()
  }

  emitter._activePaths = (): string[] => [...entries.keys()]

  return emitter
}

/** Process-wide singleton (app has one main window; multi-window refcounts via subscribe). */
let singleton: GitWatcher | null = null

export function getGitWatcher(): GitWatcher {
  if (!singleton) singleton = createGitWatcher()
  return singleton
}

export function closeGitWatcher(): void {
  if (singleton) {
    singleton.closeAll()
    singleton = null
  }
}
