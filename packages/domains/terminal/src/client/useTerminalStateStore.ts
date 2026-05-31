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
import { useMemo } from 'react'
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
  /** Self-heal: converge local state to the authoritative session list. */
  reconcile: (sessions: SessionInfoLite[]) => void
  /** Imperative read (non-reactive callers); default 'starting'. */
  getSessionState: (sessionId: string) => TerminalState
}

export const useTerminalStateStore = create<TerminalStateStore>()(
  subscribeWithSelector((set, get) => ({
    byId: {},
    hibernated: {},

    applyStateChange: (sessionId, newState) =>
      set((s) => {
        if (s.hibernated[sessionId]) {
          // The kill's own 'dead' must not clear 💤; any other transition means
          // a real reopen/respawn — drop the marker and flow through.
          if (newState === 'dead') return {}
          const { [sessionId]: _omit, ...hibernated } = s.hibernated
          return { hibernated, byId: { ...s.byId, [sessionId]: newState } }
        }
        if (s.byId[sessionId] === newState) return {}
        return { byId: { ...s.byId, [sessionId]: newState } }
      }),

    applyExit: (sessionId) =>
      set((s) => {
        if (s.hibernated[sessionId]) return {} // keep 'hibernated', not 'dead'
        if (s.byId[sessionId] === 'dead') return {}
        return { byId: { ...s.byId, [sessionId]: 'dead' } }
      }),

    applyHibernated: (sessionId) =>
      set((s) => ({
        hibernated: { ...s.hibernated, [sessionId]: true },
        byId: { ...s.byId, [sessionId]: 'hibernated' }
      })),

    clearSession: (sessionId) =>
      set((s) => {
        const { [sessionId]: _b, ...byId } = s.byId
        const { [sessionId]: _h, ...hibernated } = s.hibernated
        return { byId, hibernated }
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

    reconcile: (sessions) =>
      set((s) => {
        const present = new Map(sessions.map((x) => [x.sessionId, x.state]))
        const byId = { ...s.byId }
        let changed = false

        // Pass 1 — adopt backend drift (dropped running->idle) + fill missing.
        // Never revive a locally-'dead' sid (a respawn re-creates via its own
        // IPC; avoids flicker on a list that raced ahead of a just-applied exit).
        // Skip hibernated (dead-on-backend by design).
        for (const [sid, listState] of present) {
          if (s.hibernated[sid]) continue
          const cur = byId[sid]
          if (cur === undefined) {
            byId[sid] = listState
            changed = true
          } else if (cur !== listState && cur !== 'dead') {
            byId[sid] = listState
            changed = true
          }
        }

        // Pass 2 — a locally-alive sid absent from the list has exited (the
        // list excludes dead/ended/not-spawned), so a dropped pty:exit converges.
        for (const sid of Object.keys(byId)) {
          if (s.hibernated[sid]) continue
          if (ALIVE_STATES.has(byId[sid]) && !present.has(sid)) {
            byId[sid] = 'dead'
            changed = true
          }
        }

        return changed ? { byId } : {}
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
// ONE place applies the IPC + self-heals. Module-scope (runs once per renderer
// on first import), guarded so importing in a non-DOM context (unit tests) is a
// no-op. Mirrors settings/useTabStore.ts eager wiring + window-attach.
// ---------------------------------------------------------------------------
let _reconciling = false
async function pullReconcile(): Promise<void> {
  if (_reconciling || typeof window === 'undefined' || !window.api?.session?.list) return
  _reconciling = true
  try {
    const sessions = await window.api.session.list()
    useTerminalStateStore
      .getState()
      .reconcile(sessions.map((s) => ({ sessionId: s.sessionId, state: s.state })))
  } catch {
    // Best-effort; the next trigger retries.
  } finally {
    _reconciling = false
  }
}

function wireTerminalStateStore(): void {
  if (typeof window === 'undefined' || !window.api?.pty) return
  const store = (): TerminalStateStore => useTerminalStateStore.getState()

  window.api.pty.onStateChange((sessionId, newState) => store().applyStateChange(sessionId, newState))
  window.api.pty.onExit((sessionId) => {
    store().applyExit(sessionId)
    void pullReconcile()
  })
  window.api.pty.onHibernated((sessionId) => store().applyHibernated(sessionId))

  if (window.api.session?.list) {
    window.api.session
      .list()
      .then((sessions) =>
        store().hydrate(sessions.map((s) => ({ sessionId: s.sessionId, state: s.state })))
      )
      .catch(() => {})
  }
  if (window.api.tabs?.listHibernatedSessions) {
    window.api.tabs
      .listHibernatedSessions()
      .then((ids) => ids.forEach((id) => store().applyHibernated(id)))
      .catch(() => {})
  }

  // Self-heal triggers: window focus + a low-freq backstop interval. A dropped
  // pty:exit also triggers reconcile from the onExit handler above.
  window.addEventListener('focus', () => void pullReconcile())
  setInterval(() => void pullReconcile(), 15_000)

  // E2E/CDP handle (matches window.__slayzone_tabStore convention).
  ;(window as unknown as Record<string, unknown>).__slayzone_terminalStateStore =
    useTerminalStateStore
}

wireTerminalStateStore()
