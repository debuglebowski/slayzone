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
 *   - Excludes nested checkouts (a dir holding its own `.git`, e.g. agent worktrees
 *     under `.claude/worktrees/`) — their edits are another repo's diff — except
 *     submodules, whose changes do show in this repo's diff. Likewise the other
 *     worktrees' private state under `.git/worktrees/`.
 *   - Each emission says whether a ref moved (`refsChanged`: HEAD, refs/, packed-refs)
 *     — the commit graph refreshes on that alone, not on every file edit.
 *   - Refcounts watchers by worktreePath. Last unsubscribe closes the watcher.
 *   - On ENOSPC (Linux inotify exhaustion) or any watcher error, the watcher
 *     detaches cleanly — renderer falls back to its poll timer.
 *   - `ready(worktreePath)` resolves once the watch is LIVE (Q4): on macOS a recursive
 *     `fs.watch` returns before its FSEvents stream runs, and a change in that window
 *     is dropped, not delayed. A short-lived marker file in the gitdir is touched until
 *     the watch reports it (never in the working tree: it would show in `git status`),
 *     then one `git:diff-changed` goes out, so a change made while the watch started is
 *     picked up too. The marker's own events are never reported. Past a cap (a loaded
 *     machine) `ready` resolves with a rescan, and the watch keeps confirming: once it
 *     is live, one more rescan goes out, so no change is lost in between (R10-2); and
 *     one more once it has settled, for an event dropped in its first moments.
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'

const DEBOUNCE_MS = 200
/** Marker files `ready()` writes into the gitdir; their events are never reported. */
const READY_MARKER_PREFIX = '.slayzone-watch-ready-'
/** How often the marker is touched until the watch reports it, and for how long. */
const READY_TOUCH_MS = 40
const READY_TIMEOUT_MS = 3_000
/** After the watch goes live, when one more rescan covers an event dropped in warm-up. */
const READY_SETTLE_MS = 1_500
/** After the cap, how long a watch keeps confirming before it is given up on. */
const READY_GIVE_UP_MS = 60_000

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
  'out'
])

// Paths relative to the worktree root whose deepest segments we care about.
// `.git/objects` and `.git/logs` are noisy; we explicitly exclude them below.
const EXCLUDED_GIT_SUBDIRS = new Set(['objects', 'logs'])

export interface GitDiffChangedPayload {
  worktreePath: string
  /** A ref moved in this debounce window (commit, checkout, fetch, branch create/delete). */
  refsChanged: boolean
  /** The task / project the watch was opened for (the event's owner check). */
  taskId?: string
  projectId?: string
}

export interface GitWatcherEvents {
  'git:diff-changed': (payload: GitDiffChangedPayload) => void
  /**
   * Emitted when a watcher tears down due to an error (ENOSPC, worktree
   * deletion, platform quirk). Renderer listens and tightens its poll
   * cadence — without this it would stay pinned at WATCHER_FALLBACK_POLL_MS
   * (30s) forever, since `watchStart` already resolved successfully.
   */
  'git:diff-watch-failed': (payload: {
    worktreePath: string
    taskId?: string
    projectId?: string
  }) => void
}

export interface GitWatcher extends EventEmitter {
  subscribe(worktreePath: string): void
  /**
   * Resolves once the watch of `worktreePath` (subscribed) is live — a change after
   * this is reported — and one `git:diff-changed` was emitted for what changed while
   * it started. Never rejects: a watch that cannot be confirmed resolves at timeout.
   */
  ready(worktreePath: string): Promise<void>
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
  /** Some event in the pending debounce window moved a ref. */
  refsChanged: boolean
  /** Worktree-relative dir → holds its own `.git` (nested checkout). */
  nestedCheckoutCache: Map<string, boolean>
  /** Worktree-relative submodule paths (from `.gitmodules`) — never excluded as nested. */
  submodulePaths: Set<string>
  /** Resolves once the watch is live (see {@link GitWatcher.ready}). */
  ready: Promise<void> | null
  /** The pending readiness marker's file name, and what its event resolves. */
  marker: { name: string; seen: () => void } | null
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

/** Submodule paths declared in `<worktree>/.gitmodules` (normalized to `/`). */
function readSubmodulePaths(worktreePath: string): Set<string> {
  try {
    const content = fs.readFileSync(path.join(worktreePath, '.gitmodules'), 'utf-8')
    const paths = new Set<string>()
    for (const m of content.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
      paths.add(m[1].replace(/\\/g, '/').replace(/\/+$/, ''))
    }
    return paths
  } catch {
    return new Set()
  }
}

/** A gitdir-relative path that moves a ref. */
function isRefPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').replace(/\.lock$/, '')
  return p === 'HEAD' || p === 'packed-refs' || p.startsWith('refs/')
}

/** `p` through symlinks — only its directories when `leaf` is false (a `.git` link stays). */
function realOrSelf(p: string, leaf: boolean): string {
  try {
    return leaf ? fs.realpathSync(p) : path.join(fs.realpathSync(path.dirname(p)), path.basename(p))
  } catch {
    return p
  }
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
  // The REAL directory (R10-3): a `.git` that is a symlink is not followed by the
  // worktree's recursive watch, so it needs its own — and `ready()`'s marker must land
  // where that watch sees it. A `gitdir:` file's target may be a link too.
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  }
  if (stat.isDirectory()) return real(dotGit)
  if (!stat.isFile()) return null
  try {
    const content = fs.readFileSync(dotGit, 'utf-8').trim()
    const match = content.match(/^gitdir:\s*(.+)$/)
    if (!match) return null
    const gitdir = match[1].trim()
    return real(path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreePath, gitdir))
  } catch {
    return null
  }
}

export interface GitWatcherOptions {
  /** How long `ready()` waits for the watch to go live before reporting ready anyway
   *  (default {@link READY_TIMEOUT_MS}); tests force the capped path with 0. */
  readyTimeoutMs?: number
  /**
   * Throws to refuse watching here. Default: the hub's T-06 refusal (a hub with
   * processes switched off never watches its own disk). A computer passes none —
   * watching its checkouts is its job.
   */
  refuse?: () => void
}

export function createGitWatcher(options: GitWatcherOptions = {}): GitWatcher {
  const refuse = options.refuse ?? (() => assertHubLocalExecEnabled({ op: 'git.watch' }))
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  const entries = new Map<string, WatchEntry>()
  const emitter = new EventEmitter() as GitWatcher

  function scheduleEmit(entry: WatchEntry, refsChanged = false): void {
    if (refsChanged) entry.refsChanged = true
    if (entry.debounceTimer) return
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      if (entry.closed) return
      const payload: GitDiffChangedPayload = {
        worktreePath: entry.worktreePath,
        refsChanged: entry.refsChanged
      }
      entry.refsChanged = false
      emitter.emit('git:diff-changed', payload)
    }, DEBOUNCE_MS)
  }

  /**
   * Is a worktree-relative path inside a nested checkout (a dir below the root that
   * holds its own `.git`, not a declared submodule)? One stat per dir, cached; a
   * `.git` appearing/disappearing re-evaluates its dir.
   */
  function inNestedCheckout(entry: WatchEntry, relPath: string): boolean {
    const parts = relPath.split(/[\\/]/)
    if (parts[parts.length - 1] === '.git') {
      entry.nestedCheckoutCache.delete(parts.slice(0, -1).join('/'))
    }
    // Directories strictly below the root (the root's own `.git` is this repo).
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (entry.submodulePaths.has(dir)) continue
      let nested = entry.nestedCheckoutCache.get(dir)
      if (nested === undefined) {
        nested = fs.existsSync(path.join(entry.worktreePath, dir, '.git'))
        entry.nestedCheckoutCache.set(dir, nested)
      }
      if (nested) return true
    }
    return false
  }

  function teardown(entry: WatchEntry): void {
    if (entry.closed) return
    entry.closed = true
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    for (const w of entry.watchers) {
      try {
        w.close()
      } catch {
        /* best-effort */
      }
    }
    entry.watchers = []
  }

  function openWatcher(entry: WatchEntry, root: string, isGitDir: boolean): void {
    try {
      // `recursive: true` is safe on all three target platforms:
      //   - macOS: supported since Node 7 (FSEvents backend)
      //   - Windows: supported since Node 7 (ReadDirectoryChangesW)
      //   - Linux: supported natively since Node 20 (inotify walk)
      // Electron 44 bundles Node 24.x, so we never hit the pre-Node-20 Linux
      // silent-no-op path. If the Electron baseline ever drops below Node 20,
      // add a Linux guard here that falls back to watching .git/{index,HEAD,refs/heads}
      // non-recursively.
      const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
        if (entry.closed) return
        if (!filename) {
          // Filename is unavailable on some platforms for coalesced events —
          // still treat as a change signal (and possibly a ref move).
          scheduleEmit(entry, true)
          return
        }
        const rel: string = typeof filename === 'string' ? filename : String(filename)
        const base = path.basename(rel)
        if (base.startsWith(READY_MARKER_PREFIX)) {
          if (entry.marker && base === entry.marker.name) entry.marker.seen()
          return
        }
        const gitInRoot = !isGitDir && /^\.git[\\/]/.test(rel)
        if (!isGitDir && !gitInRoot) {
          // Working tree watcher — filter noise.
          if (isExcludedPath(rel)) return
          if (rel === '.gitmodules') entry.submodulePaths = readSubmodulePaths(entry.worktreePath)
          if (inNestedCheckout(entry, rel)) return
          scheduleEmit(entry)
        } else {
          // gitdir event (own watcher, or the main checkout's `.git/` seen by the
          // recursive worktree watch) — ignore objects/logs subtrees, and other
          // worktrees' private state (their index/HEAD; their branch moves land in refs/).
          const gitRel = gitInRoot ? rel.slice(5) : rel
          const parts = gitRel.split(/[\\/]/)
          if (EXCLUDED_GIT_SUBDIRS.has(parts[0]) || parts[0] === 'worktrees') return
          scheduleEmit(entry, isRefPath(gitRel))
        }
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
    // Watches a path on this machine's disk: on the hub, refused where processes
    // are switched off (T-06), like every other hub-local git/file access.
    refuse()
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
      refsChanged: false,
      nestedCheckoutCache: new Map(),
      submodulePaths: readSubmodulePaths(worktreePath),
      ready: null,
      marker: null
    }
    entries.set(worktreePath, entry)

    // Watch the worktree tree itself (recursive).
    openWatcher(entry, worktreePath, false)

    // Watch the resolved gitdir. On linked worktrees this is outside the
    // worktree tree so the above recursive watch doesn't see it. The main
    // checkout's `<root>/.git` is inside it — already seen, no second watcher.
    const gitdir = resolveGitDir(worktreePath)
    // The main checkout's own `.git` directory is inside the worktree's watch — but
    // not when `.git` is a symlink to elsewhere (its real path then differs).
    if (gitdir && gitdir !== realOrSelf(path.join(worktreePath, '.git'), false)) {
      openWatcher(entry, gitdir, true)
    }

    // If no watchers opened successfully, roll the entry back — renderer
    // treats watchStart failure as "poll only" mode via the preload promise.
    if (entry.watchers.length === 0) {
      entries.delete(worktreePath)
      entry.closed = true
      throw new Error('git-watcher: no watchers opened (path missing or inotify limit)')
    }
    entry.ready = untilLive(entry, gitdir)
  }

  emitter.ready = (worktreePath: string): Promise<void> =>
    entries.get(worktreePath)?.ready ?? Promise.resolve()

  /**
   * Touch a marker in `gitdir` until a watcher reports it, then emit one change for
   * what happened while the watch started. Without a gitdir there is nowhere to touch
   * that is not the user's working tree: resolved as before (no barrier).
   */
  function untilLive(entry: WatchEntry, gitdir: string | null): Promise<void> {
    if (!gitdir) return Promise.resolve()
    const name = `${READY_MARKER_PREFIX}${process.pid}-${Math.random().toString(36).slice(2)}`
    const file = path.join(gitdir, name)
    const refresh = (): void => {
      if (entry.closed) return
      try {
        emitter.emit('git:diff-changed', { worktreePath: entry.worktreePath, refsChanged: true })
      } catch {
        /* listener threw — never crash the watcher */
      }
    }
    return new Promise<void>((resolve) => {
      let live = false
      let reported = false
      let touch: NodeJS.Timeout | null = null
      const stop = (): void => {
        if (touch) clearInterval(touch)
        touch = null
        clearTimeout(cap)
        clearTimeout(giveUp)
        entry.marker = null
        fs.rm(file, { force: true }, () => undefined)
      }
      // The watch reported the marker: it is live. A rescan covers what changed while
      // it started — before `ready` resolved, or after a capped one did (R10-2).
      const seen = (): void => {
        if (live) return
        live = true
        stop()
        refresh()
        // FSEvents can still drop an event in the first moments after its stream
        // reports one (a loaded machine): one more rescan once it has settled.
        const settle = setTimeout(refresh, READY_SETTLE_MS)
        settle.unref?.()
        if (!reported) {
          reported = true
          resolve()
        }
      }
      // The cap: answer now (with a rescan) rather than block the caller, but keep
      // confirming — a change made from here until the watch is live would otherwise
      // be lost; `seen` sends one more rescan when it goes live.
      const capped = (): void => {
        if (reported) return
        reported = true
        refresh()
        resolve()
        if (touch) clearInterval(touch)
        touch = setInterval(write, READY_TOUCH_MS * 5)
      }
      entry.marker = { name, seen }
      const write = (): void => {
        if (entry.closed) {
          stop()
          if (!reported) {
            reported = true
            resolve()
          }
          return
        }
        try {
          fs.writeFileSync(file, String(Date.now()))
        } catch {
          // The gitdir is not writable: no barrier, as before.
          stop()
          if (!reported) {
            reported = true
            refresh()
            resolve()
          }
        }
      }
      touch = setInterval(write, READY_TOUCH_MS)
      const cap = setTimeout(capped, readyTimeoutMs)
      // A watch that never reports even its own marker is broken, not slow: stop
      // touching (the renderer's fallback poll covers it).
      const giveUp = setTimeout(stop, readyTimeoutMs + READY_GIVE_UP_MS)
      write()
    })
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
