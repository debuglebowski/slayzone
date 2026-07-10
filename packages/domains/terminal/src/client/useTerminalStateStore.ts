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
// via reconcile — mirrors the eager-wiring pattern in settings/useTabStore.ts.
//
// NOTE (Phase 2, in progress): this store is not yet wired into PtyContext or
// consumers — it is additive and inert until first imported.
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import { useEffect, useMemo } from 'react'
import {
  getTrpcClient,
  useSubscription,
  useTRPC,
  useTRPCClient
} from '@slayzone/transport/client'
import type { TerminalState } from '@slayzone/terminal/shared'

const ALIVE_STATES: ReadonlySet<TerminalState> = new Set(['running', 'idle'])

function taskIdFromSessionId(sessionId: string): string {
  const idx = sessionId.indexOf(':')
  return idx >= 0 ? sessionId.substring(0, idx) : sessionId
}

interface SessionInfoLite {
  sessionId: string
  state: TerminalState
}

export interface TerminalStateStore {
  /** sessionId -> state. Immutable updates only so primitive selectors stay
   *  `===`-stable for useSyncExternalStore (no tearing / infinite loops). */
  byId: Record<string, TerminalState>
  /** sessionId set (as a Record) the idle-close feature hibernated — the PTY is
   *  dead but we synthesize 'hibernated' (💤) until reopen. Read by the actions
   *  to swallow the kill's 'dead' and to skip reconcile; no selector reads it. */
  hibernated: Record<string, true>
  /** sessionId -> Date.now() of the last push event (state-change/exit/hibernated)
   *  applied to that sid. Lets `reconcile` tell a fresher push apart from a
   *  `sessionList` snapshot dispatched before the push landed — see `reconcile`. */
  lastPushedAt: Record<string, number>

  /** pty:state-change → adopt newState (swallow the kill's 'dead' while hibernated). */
  applyStateChange: (sessionId: string, newState: TerminalState) => void
  /** pty:exit → 'dead' (preserve 'hibernated'). */
  applyExit: (sessionId: string) => void
  /** pty:hibernated → synthesize 'hibernated'. */
  applyHibernated: (sessionId: string) => void
  /** resetTaskState/cleanupTask → forget a session entirely. */
  clearSession: (sessionId: string) => void
  /** Seed from session.list() on init — fill-only, never overwrite a known value. */
  hydrate: (sessions: SessionInfoLite[]) => void
  /** Self-heal: converge local state to the authoritative session list.
   *  `hibernatedIds` (the persisted `terminal_tabs.hibernated` set) is the
   *  authority for the 💤 state, which the live `sessions` list can't carry
   *  (hibernating kills the PTY → it vanishes from the list). Passing it lets
   *  any window heal hibernation it never received the window-targeted IPC for.
   *  Omit it to reconcile only liveness (legacy callers / tests).
   *  `dispatchedAt` (Date.now() taken before the `sessionList` fetch started) lets
   *  a sid with a push newer than the fetch keep its fresher local value instead
   *  of being stomped by the (now-stale) snapshot — see the flicker this fixes
   *  in `reconcile`'s body. Omit for callers without a fetch-start timestamp
   *  (legacy callers / tests) — freshness check is skipped, old behavior. */
  reconcile: (
    sessions: SessionInfoLite[],
    hibernatedIds?: readonly string[],
    dispatchedAt?: number
  ) => void
  /** Imperative read (non-reactive callers); default 'starting'. */
  getSessionState: (sessionId: string) => TerminalState
}

export const useTerminalStateStore = create<TerminalStateStore>()(
  subscribeWithSelector((set, get) => ({
    byId: {},
    hibernated: {},
    lastPushedAt: {},

    applyStateChange: (sessionId, newState) =>
      set((s) => {
        const lastPushedAt = { ...s.lastPushedAt, [sessionId]: Date.now() }
        if (s.hibernated[sessionId]) {
          // The kill's own 'dead' must not clear 💤; any other transition means
          // a real reopen/respawn — drop the marker and flow through.
          if (newState === 'dead') return { lastPushedAt }
          const { [sessionId]: _omit, ...hibernated } = s.hibernated
          return { hibernated, byId: { ...s.byId, [sessionId]: newState }, lastPushedAt }
        }
        if (s.byId[sessionId] === newState) return { lastPushedAt }
        return { byId: { ...s.byId, [sessionId]: newState }, lastPushedAt }
      }),

    applyExit: (sessionId) =>
      set((s) => {
        const lastPushedAt = { ...s.lastPushedAt, [sessionId]: Date.now() }
        if (s.hibernated[sessionId]) return { lastPushedAt } // keep 'hibernated', not 'dead'
        if (s.byId[sessionId] === 'dead') return { lastPushedAt }
        return { byId: { ...s.byId, [sessionId]: 'dead' }, lastPushedAt }
      }),

    applyHibernated: (sessionId) =>
      set((s) => ({
        hibernated: { ...s.hibernated, [sessionId]: true },
        byId: { ...s.byId, [sessionId]: 'hibernated' },
        lastPushedAt: { ...s.lastPushedAt, [sessionId]: Date.now() }
      })),

    clearSession: (sessionId) =>
      set((s) => {
        const { [sessionId]: _b, ...byId } = s.byId
        const { [sessionId]: _h, ...hibernated } = s.hibernated
        const { [sessionId]: _p, ...lastPushedAt } = s.lastPushedAt
        return { byId, hibernated, lastPushedAt }
      }),

    hydrate: (sessions) =>
      set((s) => {
        const byId = { ...s.byId }
        let changed = false
        for (const { sessionId, state } of sessions) {
          if (byId[sessionId] === undefined) {
            byId[sessionId] = state
            changed = true
          }
        }
        return changed ? { byId } : {}
      }),

    reconcile: (sessions, hibernatedIds, dispatchedAt) =>
      set((s) => {
        // A push (state-change/exit) newer than the moment this reconcile's
        // fetch was dispatched carries information the fetch's snapshot
        // couldn't have seen — the snapshot is stale for that sid, so skip the
        // stomp instead of overwriting a fresher local value with a stale one
        // (was: fresh 'running' -> flickered to a stale 'idle' every 15s/focus
        // reconcile that happened to straddle a hook-driven transition).
        const isStale = (sid: string): boolean =>
          dispatchedAt !== undefined && (s.lastPushedAt[sid] ?? 0) > dispatchedAt
        const present = new Map(sessions.map((x) => [x.sessionId, x.state]))
        // `null` = caller passed no set → reconcile liveness only, preserving the
        // legacy local-marker behavior. A set (even empty) = DB is authoritative.
        const hibSet = hibernatedIds ? new Set(hibernatedIds) : null
        const byId = { ...s.byId }
        const hibernated = { ...s.hibernated }
        let changed = false

        // Pass 0 — adopt the DB hibernated set (authoritative). Wins over a stale
        // list entry (the killed PTY can linger ~100ms in session:list). A
        // genuine reopen clears the DB flag, so a sid still in the set is asleep.
        if (hibSet) {
          for (const sid of hibSet) {
            if (byId[sid] !== 'hibernated') {
              byId[sid] = 'hibernated'
              changed = true
            }
            if (!hibernated[sid]) {
              hibernated[sid] = true
              changed = true
            }
          }
        }

        // Pass 1 — adopt backend drift (dropped running->idle) + fill missing.
        // Never revive a locally-'dead' sid (a respawn re-creates via its own
        // IPC; avoids flicker on a list that raced ahead of a just-applied exit).
        // A hibernated sid (per DB authority, or locally when no set given) is
        // dead-on-backend by design — skip it so a stale list entry can't revive
        // it. When a set IS given and the sid dropped out of it but is alive in
        // the list, that's a cross-window reopen → clear the marker + flow through.
        for (const [sid, listState] of present) {
          const lockedHibernated = hibSet ? hibSet.has(sid) : !!s.hibernated[sid]
          if (lockedHibernated) continue
          if (hibSet && hibernated[sid]) {
            delete hibernated[sid]
            changed = true
          }
          const cur = byId[sid]
          if (cur === undefined) {
            byId[sid] = listState
            changed = true
          } else if (cur !== listState && cur !== 'dead' && !isStale(sid)) {
            byId[sid] = listState
            changed = true
          }
        }

        // Pass 2 — a locally-alive sid absent from the list has exited (the
        // list excludes dead/ended/not-spawned), so a dropped pty:exit converges.
        // Skip hibernated: it's absent-but-asleep, not dead. (We never clear a
        // marker here — only positive alive evidence in Pass 1 clears it — so a
        // DB-write lag right after hibernate can't flicker 💤 off.)
        for (const sid of Object.keys(byId)) {
          if (hibernated[sid]) continue
          if (ALIVE_STATES.has(byId[sid]) && !present.has(sid) && !isStale(sid)) {
            byId[sid] = 'dead'
            changed = true
          }
        }

        return changed ? { byId, hibernated } : {}
      }),

    getSessionState: (sessionId) => get().byId[sessionId] ?? 'starting'
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
    const [sessions, hibernatedIds] = await Promise.all([
      getTrpcClient().pty.sessionList.query(),
      Promise.resolve<string[]>([])
    ])
    useTerminalStateStore
      .getState()
      .reconcile(
        sessions.map((s) => ({ sessionId: s.sessionId, state: s.state })),
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
        st().hydrate(sessions.map((s) => ({ sessionId: s.sessionId, state: s.state })))
      )
      .catch(() => {})
    trpcClient.taskTerminals.listHibernatedSessions
      .query()
      .then((ids) => ids.forEach((id) => st().applyHibernated(id)))
      .catch(() => {})
  }, [trpcClient])
}

// Self-heal triggers + E2E handle. Module-scope (runs once per renderer on first
// import), guarded so importing in a non-DOM context (unit tests) is a no-op.
// Mirrors settings/useTabStore.ts window-attach. The triggers call pullReconcile,
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
