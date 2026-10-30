/**
 * The rules of a client's terminal-state view, as plain functions: which state each
 * agent session is in, given the hub's pushes (`pty.onStateChange` / `onExit` /
 * `onBackgroundJobs` / `onHibernated`) and its snapshots (`pty.sessionList` + the
 * persisted hibernated set). Each takes the current state and an event and returns
 * a PATCH (the changed fields only; `{}` = nothing changed), never mutating its input.
 *
 * DOM-free (`@slayzone/terminal/terminal-state`): desktop's zustand store
 * (`useTerminalStateStore`) applies these patches with `set`, the phone's agent list
 * with React state — one set of rules for both. The clock is a parameter (`now`), so
 * the rules are deterministic.
 */
import type { TerminalState } from '@slayzone/terminal-contracts'

/** A session as `pty.sessionList` reports it. */
export interface SessionInfoLite {
  sessionId: string
  state: TerminalState
  /** Claude background jobs still running; absent = none. */
  backgroundJobs?: number
}

export interface TerminalStateData {
  /** sessionId -> state. Immutable updates only (selectors compare by `===`). */
  byId: Record<string, TerminalState>
  /** sessionIds the idle-close feature hibernated — the PTY is dead but the state
   *  shows 'hibernated' (💤) until reopen. Swallows the kill's 'dead'; skipped by
   *  reconcile. */
  hibernated: Record<string, true>
  /** sessionId -> time of the last push applied to it. Lets `reconcile` tell a
   *  fresher push apart from a `sessionList` snapshot dispatched before it landed. */
  lastPushedAt: Record<string, number>
  /** sessionId -> claude background jobs (Bash run_in_background / Monitor) still
   *  running. Absent = none. A separate fact from `byId`. */
  jobsById: Record<string, number>
}

export type TerminalStatePatch = Partial<TerminalStateData>

export const EMPTY_TERMINAL_STATE: TerminalStateData = {
  byId: {},
  hibernated: {},
  lastPushedAt: {},
  jobsById: {}
}

// `background` (main agent done, its background subagents still working) is as
// alive as `running` — it must count for "active" AND be eligible for the
// reconcile Pass-2 sweep, or a background session that dropped its exit event
// would never converge to 'dead'.
export const ALIVE_STATES: ReadonlySet<TerminalState> = new Set(['running', 'background', 'idle'])

/** A session's state; one never heard of reads as 'starting'. */
export function sessionStateOf(s: TerminalStateData, sessionId: string): TerminalState {
  return s.byId[sessionId] ?? 'starting'
}

/** pty:state-change → adopt newState (swallow the kill's 'dead' while hibernated). */
export function applyStateChange(
  s: TerminalStateData,
  sessionId: string,
  newState: TerminalState,
  now: number
): TerminalStatePatch {
  const lastPushedAt = { ...s.lastPushedAt, [sessionId]: now }
  if (s.hibernated[sessionId]) {
    // The kill's own 'dead' must not clear 💤; any other transition means
    // a real reopen/respawn — drop the marker and flow through.
    if (newState === 'dead') return { lastPushedAt }
    const { [sessionId]: _omit, ...hibernated } = s.hibernated
    return { hibernated, byId: { ...s.byId, [sessionId]: newState }, lastPushedAt }
  }
  if (s.byId[sessionId] === newState) return { lastPushedAt }
  return { byId: { ...s.byId, [sessionId]: newState }, lastPushedAt }
}

/** pty:exit → 'dead' (preserve 'hibernated'). */
export function applyExit(
  s: TerminalStateData,
  sessionId: string,
  now: number
): TerminalStatePatch {
  const lastPushedAt = { ...s.lastPushedAt, [sessionId]: now }
  // A dead pty took its background jobs with it.
  const { [sessionId]: _j, ...jobsById } = s.jobsById
  const jobs = sessionId in s.jobsById ? { jobsById } : {}
  if (s.hibernated[sessionId]) return { lastPushedAt, ...jobs } // keep 'hibernated', not 'dead'
  if (s.byId[sessionId] === 'dead') return { lastPushedAt, ...jobs }
  return {
    byId: { ...s.byId, [sessionId]: 'dead' },
    lastPushedAt,
    ...jobs
  }
}

/** pty:background-jobs → adopt the count. */
export function applyBackgroundJobs(
  s: TerminalStateData,
  sessionId: string,
  count: number,
  now: number
): TerminalStatePatch {
  const lastPushedAt = { ...s.lastPushedAt, [sessionId]: now }
  if ((s.jobsById[sessionId] ?? 0) === count) return { lastPushedAt }
  if (count > 0)
    return {
      jobsById: { ...s.jobsById, [sessionId]: count },
      lastPushedAt
    }
  const { [sessionId]: _j, ...jobsById } = s.jobsById
  return { jobsById, lastPushedAt }
}

/** pty:hibernated → 'hibernated'. */
export function applyHibernated(
  s: TerminalStateData,
  sessionId: string,
  now: number
): TerminalStatePatch {
  return {
    hibernated: { ...s.hibernated, [sessionId]: true },
    byId: { ...s.byId, [sessionId]: 'hibernated' },
    lastPushedAt: { ...s.lastPushedAt, [sessionId]: now }
  }
}

/** Forget a session entirely (its task's terminal state was reset). */
export function clearSession(s: TerminalStateData, sessionId: string): TerminalStatePatch {
  const { [sessionId]: _b, ...byId } = s.byId
  const { [sessionId]: _h, ...hibernated } = s.hibernated
  const { [sessionId]: _p, ...lastPushedAt } = s.lastPushedAt
  const { [sessionId]: _j, ...jobsById } = s.jobsById
  return { byId, hibernated, lastPushedAt, jobsById }
}

/** Seed from the session list — fill-only, never overwrite a known value. */
export function hydrate(
  s: TerminalStateData,
  sessions: readonly SessionInfoLite[]
): TerminalStatePatch {
  const byId = { ...s.byId }
  const jobsById = { ...s.jobsById }
  let changed = false
  for (const { sessionId, state, backgroundJobs } of sessions) {
    if (byId[sessionId] === undefined) {
      byId[sessionId] = state
      changed = true
    }
    if (backgroundJobs && jobsById[sessionId] === undefined) {
      jobsById[sessionId] = backgroundJobs
      changed = true
    }
  }
  return changed ? { byId, jobsById } : {}
}

/**
 * Self-heal: converge to the authoritative session list.
 *
 * `hibernatedIds` (the persisted `terminal_tabs.agent_state = 'auto_stopped'` set) is
 * the authority for the 💤 state, which the live list can't carry (hibernating kills
 * the PTY → it vanishes from the list). Omit it to reconcile only liveness.
 *
 * `dispatchedAt` (taken before the `sessionList` fetch started) lets a session with
 * a push newer than the fetch keep its fresher value instead of being stomped by the
 * (now-stale) snapshot. Omit it for callers without a fetch-start time (the
 * freshness check is skipped).
 */
export function reconcile(
  s: TerminalStateData,
  sessions: readonly SessionInfoLite[],
  hibernatedIds?: readonly string[],
  dispatchedAt?: number
): TerminalStatePatch {
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

  // Pass 3 — background-job counts: the list is authoritative for every
  // sid it doesn't contradict a fresher push for (absent = none).
  const jobsById = { ...s.jobsById }
  const listedJobs = new Map(sessions.map((x) => [x.sessionId, x.backgroundJobs ?? 0]))
  for (const sid of new Set([...Object.keys(jobsById), ...listedJobs.keys()])) {
    if (isStale(sid)) continue
    const want = listedJobs.get(sid) ?? 0
    if ((jobsById[sid] ?? 0) === want) continue
    if (want > 0) jobsById[sid] = want
    else delete jobsById[sid]
    changed = true
  }

  return changed ? { byId, hibernated, jobsById } : {}
}
