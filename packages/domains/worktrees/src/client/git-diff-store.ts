/**
 * Module-level refcounted store for GitDiffSnapshot polling.
 *
 * Problem: every open task tab mounts its own GitDiffPanel with its own poll
 * timer + snapshot state. Two tabs pointing at the same worktree → 2× git
 * invocations every 5s. This store shares a single poll + snapshot per
 * (targetPath, ignoreWhitespace, fromSha, toSha) tuple across all subscribers.
 *
 * Lifecycle:
 *   - First subscriber for a key creates an entry, triggers an immediate
 *     fetch, and starts a polling interval.
 *   - Subsequent subscribers re-use the entry — they see the same snapshot /
 *     loading / error state, and if they request a shorter poll interval, the
 *     timer is restarted with the minimum interval across all subscribers.
 *   - When the last subscriber unsubscribes, the interval is cleared and the
 *     cache entry is evicted synchronously. No dangling timers.
 *
 * Identity: snapshotsEqual short-circuit lives here, so parsed-diff caches
 * downstream get stable snapshot references when the underlying git state
 * hasn't changed.
 *
 * React integration:
 *   useSyncExternalStore calls `subscribe` during commit, so the subscription
 *   itself creates the store entry if absent. This keeps all subscribe /
 *   unsubscribe state inside a single React primitive — no effect-ordering
 *   races with getSnapshot returning stale EMPTY_STATE.
 */
import { useMemo, useRef, useSyncExternalStore } from 'react'
import type { GitDiffSnapshot } from '../shared/types'

export type GitDiffContextLines = '0' | '3' | '5' | 'all'

export interface GitDiffStoreParams {
  ignoreWhitespace: boolean
  fromSha?: string
  toSha?: string
  /** Unified-diff context lines to fetch. Default 'all' preserves legacy behavior. */
  contextLines?: GitDiffContextLines
  pollIntervalMs: number
}

export interface GitDiffState {
  snapshot: GitDiffSnapshot | null
  loading: boolean
  error: string | null
}

interface StoreEntry {
  key: string
  state: GitDiffState
  listeners: Set<() => void>
  /** Refcount keyed by subscriber id, value is that subscriber's requested poll interval. */
  subscribers: Map<number, number>
  /** Current active interval handle. */
  timer: ReturnType<typeof setInterval> | null
  /** Interval currently configured on timer — lets us skip a restart if unchanged. */
  timerIntervalMs: number
  targetPath: string
  ignoreWhitespace: boolean
  fromSha?: string
  toSha?: string
  contextLines: GitDiffContextLines
  /** Monotonically-incrementing fetch id; lets us drop stale responses after cancel. */
  fetchSeq: number
}

/**
 * Per-targetPath watcher refcount. All entries sharing a path share ONE
 * main-process fs watcher (via IPC refcount there too) plus ONE IPC listener
 * here. When the watcher is active we slow the poll timer to a safety net.
 */
interface PathWatcherState {
  /** Entries currently subscribed to this path (any params). Used for fanning out change events. */
  entries: Set<StoreEntry>
  /** Teardown returned by api.git.onDiffChanged — set once we register. */
  listenerDispose: (() => void) | null
  /** Teardown returned by api.git.onDiffWatchFailed — set once we register. */
  failureListenerDispose: (() => void) | null
  /** Is the main-process watcher live? `false` if watchStart failed / unavailable. */
  watcherActive: boolean
  /** Pending watchStart promise — guard against racing subscribe/unsubscribe. */
  startPromise: Promise<void> | null
}

const pathWatchers = new Map<string, PathWatcherState>()

/** Poll interval to use when fs watcher is active — safety net only. */
const WATCHER_FALLBACK_POLL_MS = 30_000

// ── Page-visibility pause (J) ─────────────────────────────────────────
// Polling is a pure background-refresh mechanism. When the window/tab is
// hidden the user cannot see the diff, so the fetch is wasted work + extra
// git process spawns. We gate every timer creation on this flag and re-arm
// all timers + trigger one catch-up fetch per entry when we become visible
// again. The fs watcher (M2) is unaffected — events still push through IPC.
let pageHidden = false

function handleVisibilityChange(): void {
  const nowHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  if (nowHidden === pageHidden) return
  pageHidden = nowHidden
  if (pageHidden) {
    // Pause every running interval; state is preserved so ensureTimer can
    // re-arm with the correct cadence on resume.
    for (const entry of entries.values()) {
      if (entry.timer) {
        clearInterval(entry.timer)
        entry.timer = null
        entry.timerIntervalMs = 0
      }
    }
  } else {
    // Resume: re-arm timers. Catch-up fetches are staggered and skipped for
    // entries whose fs watcher stayed active while hidden (watcher IPC kept
    // their snapshot fresh). Prevents an N-parallel git stampede on resume
    // when many subscribers share the process.
    let delay = 0
    for (const entry of entries.values()) {
      ensureTimer(entry)
      const watcher = pathWatchers.get(entry.targetPath)
      if (watcher?.watcherActive) continue
      const scheduleDelay = delay
      setTimeout(() => {
        void runFetch(entry)
      }, scheduleDelay)
      delay = Math.min(delay + 50, 950)
    }
  }
}

if (typeof document !== 'undefined') {
  pageHidden = document.visibilityState === 'hidden'
  document.addEventListener('visibilitychange', handleVisibilityChange)
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function snapshotsEqual(a: GitDiffSnapshot, b: GitDiffSnapshot): boolean {
  return (
    a.unstagedPatch === b.unstagedPatch &&
    a.stagedPatch === b.stagedPatch &&
    arraysEqual(a.unstagedFiles, b.unstagedFiles) &&
    arraysEqual(a.stagedFiles, b.stagedFiles) &&
    arraysEqual(a.untrackedFiles, b.untrackedFiles)
  )
}

const entries = new Map<string, StoreEntry>()
let nextSubscriberId = 1

function makeKey(
  targetPath: string,
  ignoreWhitespace: boolean,
  fromSha: string | undefined,
  toSha: string | undefined,
  contextLines: GitDiffContextLines
): string {
  return JSON.stringify({
    targetPath,
    ignoreWhitespace,
    fromSha: fromSha ?? null,
    toSha: toSha ?? null,
    contextLines
  })
}

function notify(entry: StoreEntry): void {
  for (const l of entry.listeners) l()
}

function updateState(entry: StoreEntry, patch: Partial<GitDiffState>): void {
  const next: GitDiffState = { ...entry.state, ...patch }
  if (
    next.snapshot === entry.state.snapshot &&
    next.loading === entry.state.loading &&
    next.error === entry.state.error
  ) {
    return
  }
  entry.state = next
  notify(entry)
}

async function runFetch(entry: StoreEntry): Promise<void> {
  const seq = ++entry.fetchSeq
  updateState(entry, { loading: true })
  try {
    const range: { fromSha?: string; toSha?: string } = {}
    if (entry.fromSha !== undefined) range.fromSha = entry.fromSha
    if (entry.toSha !== undefined) range.toSha = entry.toSha
    const next = await window.api.git.getWorkingDiff(entry.targetPath, {
      contextLines: entry.contextLines,
      ignoreWhitespace: entry.ignoreWhitespace,
      ...range
    })
    // If this entry was torn down or a newer fetch superseded us, drop result.
    if (entries.get(entry.key) !== entry || entry.fetchSeq !== seq) return
    const prev = entry.state.snapshot
    if (prev && snapshotsEqual(prev, next)) {
      updateState(entry, { loading: false, error: null })
    } else {
      updateState(entry, { snapshot: next, loading: false, error: null })
    }
  } catch (err) {
    if (entries.get(entry.key) !== entry || entry.fetchSeq !== seq) return
    updateState(entry, {
      snapshot: null,
      loading: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function minInterval(entry: StoreEntry): number {
  let min = Number.POSITIVE_INFINITY
  for (const ms of entry.subscribers.values()) {
    if (ms < min) min = ms
  }
  const requested = Number.isFinite(min) ? min : 5000
  // If the fs watcher for this path is active, bump the poll interval up —
  // poll is now a safety net for missed fs events (e.g. network FS / ENOSPC).
  const watcher = pathWatchers.get(entry.targetPath)
  if (watcher?.watcherActive) {
    return Math.max(requested, WATCHER_FALLBACK_POLL_MS)
  }
  return requested
}

function ensureTimer(entry: StoreEntry): void {
  // While the page is hidden we skip arming the interval entirely — the
  // visibilitychange handler re-calls ensureTimer for every entry on resume.
  if (pageHidden) {
    if (entry.timer) {
      clearInterval(entry.timer)
      entry.timer = null
      entry.timerIntervalMs = 0
    }
    return
  }
  const target = minInterval(entry)
  if (entry.timer && entry.timerIntervalMs === target) return
  if (entry.timer) {
    clearInterval(entry.timer)
    entry.timer = null
  }
  entry.timerIntervalMs = target
  entry.timer = setInterval(() => {
    void runFetch(entry)
  }, target)
}

/**
 * When ANY entry whose targetPath matches `worktreePath` is subscribed,
 * re-fetch it. Git state changed → all param variants (staged/unstaged,
 * different context levels, whitespace on/off) need a refresh. We don't
 * narrow to specific keys because they share the underlying git HEAD / index.
 */
function handleDiffChanged(worktreePath: string): void {
  const state = pathWatchers.get(worktreePath)
  if (!state) return
  for (const entry of state.entries) {
    void runFetch(entry)
  }
}

/**
 * Re-evaluate timers on every entry that shares this path — used after a
 * watcher flips state (active ↔ inactive) so intervals retarget.
 */
function retimeAllForPath(worktreePath: string): void {
  const state = pathWatchers.get(worktreePath)
  if (!state) return
  for (const entry of state.entries) ensureTimer(entry)
}

function acquirePathWatcher(targetPath: string, entry: StoreEntry): void {
  let state = pathWatchers.get(targetPath)
  if (!state) {
    state = {
      entries: new Set(),
      listenerDispose: null,
      failureListenerDispose: null,
      watcherActive: false,
      startPromise: null
    }
    pathWatchers.set(targetPath, state)
  }
  state.entries.add(entry)
  if (state.entries.size > 1) return // already kicked off

  // Register IPC listener before watchStart so we don't miss the first event.
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.git?.onDiffChanged || !api.git.watchStart) {
    // Preload surface unavailable (SSR / tests) → poll-only.
    return
  }

  state.listenerDispose = api.git.onDiffChanged((changedPath) => {
    if (changedPath === targetPath) handleDiffChanged(targetPath)
  })

  // Listen for main-process watcher death (ENOSPC, worktree removed, etc.).
  // Without this, watcherActive stays true forever and the poll timer is
  // stuck at WATCHER_FALLBACK_POLL_MS (30s) even though no fs events will
  // arrive. Flip watcherActive off + re-arm timers so poll tightens back
  // to the subscriber-requested cadence (typically 5s).
  if (api.git.onDiffWatchFailed) {
    const capturedStateForFailure = state
    capturedStateForFailure.failureListenerDispose = api.git.onDiffWatchFailed((failedPath) => {
      if (failedPath !== targetPath) return
      // Ensure this state is still the canonical one for the path — a
      // release/re-acquire race could have replaced it.
      if (pathWatchers.get(targetPath) !== capturedStateForFailure) return
      if (!capturedStateForFailure.watcherActive) return
      capturedStateForFailure.watcherActive = false
      retimeAllForPath(targetPath)
      // Trigger an immediate catch-up fetch — something just changed on disk
      // that caused the watcher to die, and we don't want to wait for the
      // next poll tick to surface it.
      for (const e of capturedStateForFailure.entries) void runFetch(e)
    })
  }

  const capturedState = state
  capturedState.startPromise = api.git.watchStart(targetPath).then(
    () => {
      // Subscribe may have been torn down while start was in flight.
      if (pathWatchers.get(targetPath) !== capturedState) return
      capturedState.watcherActive = true
      capturedState.startPromise = null
      retimeAllForPath(targetPath)
    },
    (err) => {
      capturedState.startPromise = null
      capturedState.watcherActive = false
      // Log once — watchStart throws on ENOSPC / path-missing; poll handles it.
      console.warn('[git-diff-store] watchStart failed, poll-only mode for', targetPath, err)
    }
  )
}

function releasePathWatcher(targetPath: string, entry: StoreEntry): void {
  const state = pathWatchers.get(targetPath)
  if (!state) return
  state.entries.delete(entry)
  if (state.entries.size > 0) return
  // Last subscriber — tear down.
  if (state.listenerDispose) {
    try {
      state.listenerDispose()
    } catch {
      /* ignore */
    }
    state.listenerDispose = null
  }
  if (state.failureListenerDispose) {
    try {
      state.failureListenerDispose()
    } catch {
      /* ignore */
    }
    state.failureListenerDispose = null
  }
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (state.watcherActive && api?.git?.watchStop) {
    // Best-effort — we don't await.
    void api.git.watchStop(targetPath).catch(() => {
      /* ignore */
    })
  } else if (state.startPromise && api?.git?.watchStop) {
    // Started while we were in flight — stop after start resolves, to keep
    // main-process refcount balanced.
    void state.startPromise.then(() =>
      api.git.watchStop(targetPath).catch(() => {
        /* ignore */
      })
    )
  }
  state.watcherActive = false
  pathWatchers.delete(targetPath)
}

interface SubscribeArgs {
  targetPath: string
  ignoreWhitespace: boolean
  fromSha?: string
  toSha?: string
  contextLines: GitDiffContextLines
  pollIntervalMs: number
}

function subscribeEntry(args: SubscribeArgs, listener: () => void): () => void {
  const key = makeKey(
    args.targetPath,
    args.ignoreWhitespace,
    args.fromSha,
    args.toSha,
    args.contextLines
  )
  let entry = entries.get(key)
  const created = !entry
  if (!entry) {
    entry = {
      key,
      state: { snapshot: null, loading: false, error: null },
      listeners: new Set(),
      subscribers: new Map(),
      timer: null,
      timerIntervalMs: 0,
      targetPath: args.targetPath,
      ignoreWhitespace: args.ignoreWhitespace,
      fromSha: args.fromSha,
      toSha: args.toSha,
      contextLines: args.contextLines,
      fetchSeq: 0
    }
    entries.set(key, entry)
  }
  const id = nextSubscriberId++
  entry.subscribers.set(id, args.pollIntervalMs)
  entry.listeners.add(listener)
  if (created) {
    // Kick off fs watcher for this path BEFORE the first fetch so any event
    // that lands during the initial fetch still triggers a refresh. The
    // watcher's change handler calls runFetch which is idempotent vs. inflight
    // fetches (fetchSeq guards).
    acquirePathWatcher(args.targetPath, entry)
  } else {
    // Re-entry — ensure this entry is in the path's set. `acquirePathWatcher`
    // idempotent-adds; refcount only bumps on first-for-path.
    const existingState = pathWatchers.get(args.targetPath)
    if (existingState && !existingState.entries.has(entry)) {
      existingState.entries.add(entry)
    }
  }
  ensureTimer(entry)
  if (created) {
    void runFetch(entry)
  }
  const entryRef = entry
  return () => {
    entryRef.listeners.delete(listener)
    entryRef.subscribers.delete(id)
    if (entryRef.subscribers.size === 0) {
      if (entryRef.timer) {
        clearInterval(entryRef.timer)
        entryRef.timer = null
      }
      // Invalidate any in-flight fetch.
      entryRef.fetchSeq++
      // Release the path watcher refcount attached to this entry.
      releasePathWatcher(entryRef.targetPath, entryRef)
      // Only evict if still the canonical entry at this key (a subsequent
      // acquire may have created a fresh one with the same key after
      // re-subscribe — but since our entry had zero subscribers, it can only
      // have been this one).
      if (entries.get(key) === entryRef) entries.delete(key)
    } else {
      ensureTimer(entryRef)
    }
  }
}

export interface UseGitDiffSnapshotResult extends GitDiffState {
  refresh: () => void
}

const EMPTY_STATE: GitDiffState = { snapshot: null, loading: false, error: null }

/**
 * React hook. Subscribes to the shared git-diff store for the given target.
 *
 * `visible=false` or `targetPath=null` → no subscription held, no poll.
 */
export function useGitDiffSnapshot(
  targetPath: string | null,
  params: GitDiffStoreParams & { visible: boolean }
): UseGitDiffSnapshotResult {
  const contextLines: GitDiffContextLines = params.contextLines ?? 'all'
  const active = params.visible && !!targetPath
  const key =
    active && targetPath
      ? makeKey(targetPath, params.ignoreWhitespace, params.fromSha, params.toSha, contextLines)
      : null

  // Subscribe + getSnapshot must be stable across renders at the same key so
  // useSyncExternalStore does not tear down / recreate every render. We
  // memoize on `key` + every param that feeds into subscribeEntry.
  const subscribe = useMemo(() => {
    if (!active || !targetPath) return (_listener: () => void) => () => {}
    const args: SubscribeArgs = {
      targetPath,
      ignoreWhitespace: params.ignoreWhitespace,
      fromSha: params.fromSha,
      toSha: params.toSha,
      contextLines,
      pollIntervalMs: params.pollIntervalMs
    }
    return (listener: () => void) => subscribeEntry(args, listener)
  }, [
    active,
    targetPath,
    params.ignoreWhitespace,
    params.fromSha,
    params.toSha,
    contextLines,
    params.pollIntervalMs
  ])

  const getSnapshot = useMemo(() => {
    if (!key) return () => EMPTY_STATE
    return () => {
      const e = entries.get(key)
      return e ? e.state : EMPTY_STATE
    }
  }, [key])

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Stable refresh — reads current key from a ref so identity doesn't change
  // per render (downstream useImperativeHandle depends on stable refresh).
  const keyRef = useRef(key)
  keyRef.current = key
  const refreshRef = useRef<() => void>(() => {
    const k = keyRef.current
    if (!k) return
    const e = entries.get(k)
    if (e) void runFetch(e)
  })

  return { ...state, refresh: refreshRef.current }
}

// ── Diagnostic / test hooks (not re-exported from package index) ────────

export function _storeStats(): { entries: number; subscribers: number; timers: number } {
  let subs = 0
  let timers = 0
  for (const e of entries.values()) {
    subs += e.subscribers.size
    if (e.timer) timers++
  }
  return { entries: entries.size, subscribers: subs, timers }
}

export function _storeEntryKeys(): string[] {
  return [...entries.keys()]
}

export function _resetStore(): void {
  for (const e of entries.values()) {
    if (e.timer) clearInterval(e.timer)
  }
  entries.clear()
  for (const [p, state] of pathWatchers) {
    if (state.listenerDispose) {
      try {
        state.listenerDispose()
      } catch {
        /* ignore */
      }
    }
    if (state.failureListenerDispose) {
      try {
        state.failureListenerDispose()
      } catch {
        /* ignore */
      }
    }
    if (state.watcherActive) {
      const api = typeof window !== 'undefined' ? window.api : undefined
      if (api?.git?.watchStop)
        void api.git.watchStop(p).catch(() => {
          /* ignore */
        })
    }
  }
  pathWatchers.clear()
}

export function _pathWatcherStats(): { paths: number; active: number } {
  let active = 0
  for (const s of pathWatchers.values()) {
    if (s.watcherActive) active++
  }
  return { paths: pathWatchers.size, active }
}
