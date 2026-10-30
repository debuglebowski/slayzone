// Single reactive store for terminal STATE (the `TerminalState` that drives the
// status dot). Source of truth for the `state` fact only — event streams
// (data/exit/prompt/title/...) stay in PtyContext; those are high-frequency
// callbacks, not render-state. Consumers derive via the selector hooks below
// (useSyncExternalStore under the hood), so React owns subscription lifecycle
// and app cleanup can't orphan a subscriber (the bug class that froze the dot).
//
// Keyed by sessionId (matches the backend + preserves split-pane granularity);
// the task-level view is a derived selector over the main session
// `${taskId}:${taskId}`. ONE module-scope block applies the IPC + self-heals
// via reconcile — mirrors the eager-wiring pattern in tabs-state/useTabStore.ts.
//
// NOTE (Phase 2, in progress): this store is not yet wired into PtyContext or
// consumers — it is additive and inert until first imported.
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import { useEffect, useMemo } from 'react'
import { useSubscription } from '@slayzone/transport/client'
import { getTrpcClient, listHubClients, useTRPC, useTRPCClient } from './trpc'
import type { TerminalState } from '@slayzone/terminal-contracts'
import { listHibernatedSessionIds } from './hibernated-sessions-source'
import { taskIdFromSessionId } from './session-id'
import {
  ALIVE_STATES,
  applyBackgroundJobs,
  applyExit,
  applyHibernated,
  applyStateChange,
  clearSession,
  EMPTY_TERMINAL_STATE,
  hydrate,
  reconcile,
  type SessionInfoLite,
  sessionStateOf,
  type TerminalStateData
} from './terminal-state-reducer'

export interface TerminalStateStore extends TerminalStateData {
  /** pty:state-change → adopt newState (swallow the kill's 'dead' while hibernated). */
  applyStateChange: (sessionId: string, newState: TerminalState) => void
  /** pty:exit → 'dead' (preserve 'hibernated'). */
  applyExit: (sessionId: string) => void
  /** pty:background-jobs → adopt the count. */
  applyBackgroundJobs: (sessionId: string, count: number) => void
  /** pty:hibernated → synthesize 'hibernated'. */
  applyHibernated: (sessionId: string) => void
  /** resetTaskState/cleanupTask → forget a session entirely. */
  clearSession: (sessionId: string) => void
  /** Seed from session.list() on init — fill-only, never overwrite a known value. */
  hydrate: (sessions: SessionInfoLite[]) => void
  /** Self-heal: converge local state to the authoritative session list
   *  (`reconcile` in terminal-state-reducer.ts says how `hibernatedIds` and
   *  `dispatchedAt` are used; omit them for legacy liveness-only behaviour). */
  reconcile: (
    sessions: SessionInfoLite[],
    hibernatedIds?: readonly string[],
    dispatchedAt?: number
  ) => void
  /** Imperative read (non-reactive callers); default 'starting'. */
  getSessionState: (sessionId: string) => TerminalState
}

// The rules are the DOM-free reducers (`terminal-state-reducer.ts`, shared with the
// phone); this store only applies their patches.
export const useTerminalStateStore = create<TerminalStateStore>()(
  subscribeWithSelector((set, get) => ({
    ...EMPTY_TERMINAL_STATE,

    applyStateChange: (sessionId, newState) =>
      set((s) => applyStateChange(s, sessionId, newState, Date.now())),

    applyExit: (sessionId) => set((s) => applyExit(s, sessionId, Date.now())),

    applyBackgroundJobs: (sessionId, count) =>
      set((s) => applyBackgroundJobs(s, sessionId, count, Date.now())),

    applyHibernated: (sessionId) => set((s) => applyHibernated(s, sessionId, Date.now())),

    clearSession: (sessionId) => set((s) => clearSession(s, sessionId)),

    hydrate: (sessions) => set((s) => hydrate(s, sessions)),

    reconcile: (sessions, hibernatedIds, dispatchedAt) =>
      set((s) => reconcile(s, sessions, hibernatedIds, dispatchedAt)),

    getSessionState: (sessionId) => sessionStateOf(get(), sessionId)
  }))
)

// ---------------------------------------------------------------------------
// Selector hooks — consumers derive from here (replaces per-session manual
// subscribeState wiring + the shadow `terminalStates` map).
// ---------------------------------------------------------------------------

/** Per-session state (per-pane consumers). Primitive → no equality fn needed. */
export function useSessionState(sessionId: string): TerminalState {
  return useTerminalStateStore((s) => s.byId[sessionId] ?? 'starting')
}

/** Per-session state but `undefined` when the session is unknown (no entry) —
 *  for `alwaysShow` dots that render a muted "No session" indicator for tasks
 *  without a live terminal, vs a styled dot once a session exists. */
export function useSessionStateRaw(sessionId: string): TerminalState | undefined {
  return useTerminalStateStore((s) => s.byId[sessionId])
}

/** Claude background jobs still running in a session (0 = none). */
export function useSessionBackgroundJobs(sessionId: string): number {
  return useTerminalStateStore((s) => s.jobsById[sessionId] ?? 0)
}

/** Task-level state — the task's MAIN session is `${taskId}:${taskId}`. */
export function useTaskTerminalState(taskId: string): TerminalState {
  return useTerminalStateStore((s) => s.byId[`${taskId}:${taskId}`] ?? 'starting')
}

/** Task IDs with any ALIVE (running|idle) session. useShallow over a sorted
 *  array → re-renders only on membership change; boxed to a Set for the API. */
export function useActiveTaskIds(): Set<string> {
  const ids = useTerminalStateStore(
    useShallow((s) => {
      const seen = new Set<string>()
      const out: string[] = []
      for (const sid in s.byId) {
        if (ALIVE_STATES.has(s.byId[sid])) {
          const tid = taskIdFromSessionId(sid)
          if (!seen.has(tid)) {
            seen.add(tid)
            out.push(tid)
          }
        }
      }
      return out.sort()
    })
  )
  return useMemo(() => new Set(ids), [ids])
}

// ---------------------------------------------------------------------------
// Self-heal + event wiring. The reactive subscriptions (state-change / exit /
// hibernated) + the initial hydrate now run via `useWireTerminalStateStore`,
// mounted ONCE per renderer inside PtyProvider (the tRPC client isn't ready at
// module-import time — it's set by TrpcProvider on mount — so the eager
// `sessionList` query can't run at module scope anymore). The module-scope block
// below only keeps the transport-agnostic self-heal triggers (focus + 15s
// backstop) that call `pullReconcile`, which guards on the tRPC client being
// ready, plus the E2E window handle.
// ---------------------------------------------------------------------------
let _reconciling = false
async function pullReconcile(): Promise<void> {
  if (_reconciling || typeof window === 'undefined') return
  _reconciling = true
  // Stamped before the fetch fires so `reconcile` can tell a push that landed
  // WHILE this fetch was in flight (fresher than what the snapshot could see)
  // apart from one that landed before it (safe to trust the snapshot for).
  const dispatchedAt = Date.now()
  try {
    // Pull liveness + the authoritative hibernated set together so reconcile can
    // heal 💤 in any window, not just the one that owned the session when the
    // window-targeted pty:hibernated IPC fired (the cross-window stale-dot bug).
    // `sessionList` is the tRPC procedure (throws if the client isn't mounted yet
    // — caught below). The hibernated-set seed has NO tRPC router procedure yet
    // (PTY-hibernation seeding is a separate slice) and the old
    // The old hibernated-session preload bridge is gone (preload is
    // bootstrap-only), so it resolves to [] until that procedure lands.
    // Multi-hub: union the live session list across EVERY connected hub (a
    // remote task's pty lives on its hub, so its liveness only shows in that
    // hub's sessionList). listHubClients() is [default] when single-hub →
    // byte-identical. Per-hub failures are swallowed so one down hub doesn't
    // block reconcile for the others.
    const clients = listHubClients()
    const perHub = await Promise.all(
      (clients.length > 0 ? clients.map((c) => c.client) : [getTrpcClient()]).map((c) =>
        c.pty.sessionList.query().catch(
          () =>
            [] as Array<{
              sessionId: string
              state: string
              backgroundJobs?: number
            }>
        )
      )
    )
    const sessions = perHub.flat()
    const hibernatedIds: string[] = []
    useTerminalStateStore.getState().reconcile(
      sessions.map((s) => ({
        sessionId: s.sessionId,
        state: s.state as TerminalState,
        backgroundJobs: s.backgroundJobs
      })),
      hibernatedIds,
      dispatchedAt
    )
  } catch {
    // Best-effort; the next trigger retries (also covers the tRPC-client-not-yet-
    // ready window right after boot — the React hook's initial hydrate fills it).
  } finally {
    _reconciling = false
  }
}

/**
 * React-scope wiring for the terminal-state store. Mount ONCE per renderer
 * (PtyProvider). Subscribes to the pty state-change / exit / hibernated event
 * streams via tRPC subscriptions, seeds the store from the authoritative session
 * list + hibernated set on mount, and self-heals on a dropped exit. Replaces the
 * old module-scope IPC wiring (which can't run before TrpcProvider mounts).
 */
export function useWireTerminalStateStore(): void {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const store = (): TerminalStateStore => useTerminalStateStore.getState()

  useSubscription(
    trpc.pty.onStateChange.subscriptionOptions(undefined, {
      onData: ({ sessionId, newState }) =>
        store().applyStateChange(sessionId, newState as TerminalState)
    })
  )

  useSubscription(
    trpc.pty.onExit.subscriptionOptions(undefined, {
      onData: ({ sessionId }) => {
        store().applyExit(sessionId)
        void pullReconcile()
      }
    })
  )

  useSubscription(
    trpc.pty.onBackgroundJobs.subscriptionOptions(undefined, {
      onData: ({ sessionId, count }) => store().applyBackgroundJobs(sessionId, count)
    })
  )

  useSubscription(
    trpc.pty.onHibernated.subscriptionOptions(undefined, {
      onData: ({ sessionId }) => store().applyHibernated(sessionId)
    })
  )

  // Initial seed: liveness from the session list (fill-only hydrate) + the
  // persisted hibernated set. Runs once on mount. Reads the store singleton
  // via getState() (no extra dep) so trpcClient is the only dependency.
  useEffect(() => {
    const st = (): TerminalStateStore => useTerminalStateStore.getState()
    trpcClient.pty.sessionList
      .query()
      .then((sessions) =>
        st().hydrate(
          sessions.map((s) => ({
            sessionId: s.sessionId,
            state: s.state,
            backgroundJobs: s.backgroundJobs
          }))
        )
      )
      .catch(() => {
        // Seed only: the store already defaults every session to "unknown", and
        // the focus/interval self-heal below re-runs the same reconcile.
      })
    // The hibernated set is task-terminals' (above terminal) — read through the
    // app-registered source, re-run whenever the provider's client changes.
    listHibernatedSessionIds()
      .then((ids) => ids.forEach((id) => st().applyHibernated(id)))
      .catch(() => {
        // Same as above — a missed hibernated set heals on the next reconcile.
      })
  }, [trpcClient])
}

// Self-heal triggers + E2E handle. Module-scope (runs once per renderer on first
// import), guarded so importing in a non-DOM context (unit tests) is a no-op.
// Mirrors tabs-state/useTabStore.ts window-attach. The triggers call pullReconcile,
// which no-ops until the tRPC client is mounted.
if (typeof window !== 'undefined') {
  // Self-heal triggers: window focus + a low-freq backstop interval. A dropped
  // pty:exit also triggers reconcile from the onExit subscription above.
  window.addEventListener('focus', () => void pullReconcile())
  // Module-scope wiring, not a component — useVisibleInterval (a hook) can't run
  // here. The 15s tick must keep firing so a window left in the background still
  // heals stale dots (e.g. 💤 from a cross-window hibernate); the focus listener
  // above covers the foregrounded case. Low frequency keeps hidden-CPU trivial.
  // eslint-disable-next-line no-restricted-syntax
  setInterval(() => void pullReconcile(), 15_000)

  // E2E/CDP handle (matches window.__slayzone_tabStore convention).
  ;(window as unknown as Record<string, unknown>).__slayzone_terminalStateStore =
    useTerminalStateStore
}
