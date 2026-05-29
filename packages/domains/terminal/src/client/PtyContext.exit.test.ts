/**
 * Regression tests for PtyContext exit handling.
 * Run with: npx tsx packages/domains/terminal/src/client/PtyContext.exit.test.ts
 */
import { applyExitEvent, dropStateSubsIfEmpty } from './PtyContext'
import type { TerminalState } from '@slayzone/terminal/shared'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    failed++
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    }
  }
}

test('transitions state to dead and notifies state + exit subscribers', () => {
  const stateSubs = new Map<
    string,
    Set<(newState: TerminalState, oldState: TerminalState) => void>
  >()
  const exitSubs = new Map<string, Set<(exitCode: number) => void>>()
  const stateChanges: Array<{ newState: TerminalState; oldState: TerminalState }> = []
  const exits: number[] = []

  stateSubs.set('s1', new Set([(newState, oldState) => stateChanges.push({ newState, oldState })]))
  exitSubs.set('s1', new Set([(exitCode) => exits.push(exitCode)]))

  const state = {
    lastSeq: 12,
    sessionInvalid: false,
    state: 'running' as TerminalState,
    exitCode: undefined as number | undefined,
    crashOutput: undefined as string | undefined
  }
  state.exitCode = 0

  applyExitEvent('s1', 7, state, stateSubs, exitSubs)

  expect(state.state).toBe('dead')
  expect(stateChanges.length).toBe(1)
  expect(stateChanges[0].newState).toBe('dead')
  expect(stateChanges[0].oldState).toBe('running')
  expect(exits.length).toBe(1)
  expect(exits[0]).toBe(7)
})

test('notifies exit subscribers even if local state is missing', () => {
  const stateSubs = new Map<
    string,
    Set<(newState: TerminalState, oldState: TerminalState) => void>
  >()
  const exitSubs = new Map<string, Set<(exitCode: number) => void>>()
  const exits: number[] = []

  exitSubs.set('s2', new Set([(exitCode) => exits.push(exitCode)]))

  applyExitEvent('s2', 0, undefined, stateSubs, exitSubs)

  expect(exits.length).toBe(1)
  expect(exits[0]).toBe(0)
})

test('programmatic kill (PTY_EXIT_KILLED_BY_HOST = -2) produces dead state + exit notify', () => {
  // Guards the fix for GitHub issue #77 on the renderer side: when main dispatches
  // pty:exit with the host-kill sentinel, the same code path runs as a natural exit —
  // state flips to 'dead' and Retry overlay gates open.
  const PTY_EXIT_KILLED_BY_HOST = -2
  const stateSubs = new Map<
    string,
    Set<(newState: TerminalState, oldState: TerminalState) => void>
  >()
  const exitSubs = new Map<string, Set<(exitCode: number) => void>>()
  const stateChanges: Array<{ newState: TerminalState; oldState: TerminalState }> = []
  const exits: number[] = []

  stateSubs.set('killed', new Set([(n, o) => stateChanges.push({ newState: n, oldState: o })]))
  exitSubs.set('killed', new Set([(code) => exits.push(code)]))

  const state = {
    lastSeq: 3,
    sessionInvalid: false,
    state: 'idle' as TerminalState,
    exitCode: undefined as number | undefined,
    crashOutput: undefined as string | undefined
  }

  applyExitEvent('killed', PTY_EXIT_KILLED_BY_HOST, state, stateSubs, exitSubs)

  expect(state.state).toBe('dead')
  expect(stateChanges.length).toBe(1)
  expect(stateChanges[0].newState).toBe('dead')
  expect(stateChanges[0].oldState).toBe('idle')
  expect(exits.length).toBe(1)
  expect(exits[0]).toBe(PTY_EXIT_KILLED_BY_HOST)
})

test('double exit is idempotent — second call does not re-notify state subscribers', () => {
  // The renderer-side applyExitEvent only transitions to 'dead' once; a subsequent
  // pty:exit (e.g. if the 500ms watchdog races with the real onExit) must not
  // re-emit state changes.
  const stateSubs = new Map<
    string,
    Set<(newState: TerminalState, oldState: TerminalState) => void>
  >()
  const exitSubs = new Map<string, Set<(exitCode: number) => void>>()
  const stateChanges: Array<{ newState: TerminalState; oldState: TerminalState }> = []
  const exits: number[] = []

  stateSubs.set('s3', new Set([(n, o) => stateChanges.push({ newState: n, oldState: o })]))
  exitSubs.set('s3', new Set([(code) => exits.push(code)]))

  const state = {
    lastSeq: 0,
    sessionInvalid: false,
    state: 'running' as TerminalState,
    exitCode: undefined as number | undefined,
    crashOutput: undefined as string | undefined
  }

  applyExitEvent('s3', -2, state, stateSubs, exitSubs)
  applyExitEvent('s3', -2, state, stateSubs, exitSubs)

  // Only one state transition since state.state === 'dead' after the first call
  expect(stateChanges.length).toBe(1)
  // Exit subscribers are intentionally notified on every call (same as natural exits)
  expect(exits.length).toBe(2)
})

// ---------------------------------------------------------------------------
// Root-cause characterization: "sidebar spinner stuck on running, backend idle"
//
// Reproduces the reset-before-kill respawn path used by handleRestartTerminal /
// handleResetTerminal / handleStopAgent (TaskDetailPage.tsx:1213/1232/1224) and
// the auto-revive (onRespawnSuggested:1253). Each does:
//     resetTaskState(sid)   // PtyContext.tsx:498 -> statesRef.delete(sid)
//     await pty.kill(sid)    // -> pty:exit -> onExit
//
// These tests pin the CURRENT (buggy) behavior so we can be certain of the
// mechanism. The fix will flip T1/T3 (a stale sidebar cb must still learn the
// session left 'running'). Until then, they document why the dot freezes green.
// ---------------------------------------------------------------------------

test('ROOT CAUSE T1: state pre-deleted (reset-before-kill) -> exit does NOT notify state subs', () => {
  // resetTaskState deleted statesRef[sid] before the kill, so onExit passes
  // state=undefined to applyExitEvent. The `if (state)` guard then skips the
  // 'dead' notify entirely — the sidebar's long-lived state cb never hears it.
  const stateSubs = new Map<
    string,
    Set<(newState: TerminalState, oldState: TerminalState) => void>
  >()
  const exitSubs = new Map<string, Set<(exitCode: number) => void>>()
  const stateChanges: Array<{ newState: TerminalState; oldState: TerminalState }> = []
  const exits: number[] = []

  // Sidebar (useTerminalStateTracking) cb is subscribed for this session...
  stateSubs.set('sid', new Set([(n, o) => stateChanges.push({ newState: n, oldState: o })]))
  exitSubs.set('sid', new Set([(code) => exits.push(code)]))

  // ...but statesRef entry was already removed by resetTaskState -> state undefined.
  applyExitEvent('sid', -2, undefined, stateSubs, exitSubs)

  // The bug: NO 'dead' reaches the sidebar cb. (A correct impl would deliver it.)
  expect(stateChanges.length).toBe(0)
  // Exit subs still fire (that path is unconditional).
  expect(exits.length).toBe(1)
})

test('ROOT CAUSE T2: contrast — natural exit (state present) DOES notify with dead', () => {
  // Same kill, but WITHOUT a preceding resetTaskState: statesRef still holds the
  // session, so applyExitEvent fires 'dead'. This is why a natural crash freezes
  // the dot GRAY ('dead') while reset-before-kill freezes it GREEN ('running').
  const stateSubs = new Map<
    string,
    Set<(newState: TerminalState, oldState: TerminalState) => void>
  >()
  const exitSubs = new Map<string, Set<(exitCode: number) => void>>()
  const stateChanges: Array<{ newState: TerminalState; oldState: TerminalState }> = []

  stateSubs.set('sid', new Set([(n, o) => stateChanges.push({ newState: n, oldState: o })]))
  exitSubs.set('sid', new Set())

  const state = {
    lastSeq: 1,
    sessionInvalid: false,
    state: 'running' as TerminalState,
    exitCode: undefined as number | undefined,
    crashOutput: undefined as string | undefined
  }

  applyExitEvent('sid', -2, state, stateSubs, exitSubs)

  expect(stateChanges.length).toBe(1)
  expect(stateChanges[0].newState).toBe('dead')
  expect(stateChanges[0].oldState).toBe('running')
})

test('ROOT CAUSE T3: full chain — sidebar map frozen on running while backend goes idle', () => {
  // Faithful model of PtyContext bookkeeping (statesRef + stateSubsRef) and
  // onExit's delete order (PtyContext.tsx:205 applyExitEvent -> 215
  // stateSubsRef.delete), driven through a reset-before-kill respawn. The sidebar
  // cb (useTerminalStateTracking) is long-lived and does NOT re-subscribe because
  // the task tab stays open (trackedTaskIds/key unchanged), so it is never
  // re-added after the delete. Uses the REAL applyExitEvent for the linchpin step.
  type PtyState = {
    lastSeq: number
    sessionInvalid: boolean
    state: TerminalState
    exitCode?: number
    crashOutput?: string
  }
  const sid = 'task:task'
  const statesRef = new Map<string, PtyState>()
  const stateSubs = new Map<
    string,
    Set<(n: TerminalState, o: TerminalState) => void>
  >()
  const exitSubs = new Map<string, Set<(code: number) => void>>()

  // Mirror of PtyContext.getOrCreateState (157) + onStateChange (235-245).
  const getOrCreateState = (id: string): PtyState => {
    let s = statesRef.get(id)
    if (!s) {
      s = { lastSeq: -1, sessionInvalid: false, state: 'starting' }
      statesRef.set(id, s)
    }
    return s
  }
  const onStateChange = (id: string, next: TerminalState): void => {
    const s = getOrCreateState(id)
    const old = s.state
    s.state = next
    stateSubs.get(id)?.forEach((cb) => cb(next, old)) // orphaned set -> no-op
  }

  // The sidebar's tracked value (useTerminalStateTracking.terminalStates[taskId]).
  let sidebarValue: TerminalState | undefined
  const sidebarCb = (next: TerminalState): void => {
    sidebarValue = next
  }

  // 1) Subscribe + go running (turn in progress). Sidebar shows 'running'.
  getOrCreateState(sid).state = 'idle'
  stateSubs.set(sid, new Set([sidebarCb]))
  onStateChange(sid, 'running')
  expect(sidebarValue).toBe('running')

  // 2) resetTaskState(sid): statesRef.delete (PtyContext.tsx:498).
  statesRef.delete(sid)

  // 3) kill -> pty:exit -> onExit. state is now undefined; applyExitEvent (REAL)
  //    must not deliver 'dead'; then onExit deletes the subscriber set (orphan).
  applyExitEvent(sid, -2, statesRef.get(sid), stateSubs, exitSubs)
  stateSubs.delete(sid) // PtyContext.tsx:215

  // 4) New PTY reuses the same sessionId and settles to idle, then a full turn.
  onStateChange(sid, 'starting')
  onStateChange(sid, 'idle')
  onStateChange(sid, 'running')
  onStateChange(sid, 'idle') // backend hook:Stop -> idle (matches diagnostics)

  // Backend (statesRef) correctly recovered to idle...
  expect(statesRef.get(sid)!.state).toBe('idle')
  // ...but the sidebar cb was orphaned at step 3 and never heard anything since
  // 'running' at step 1 -> FROZEN GREEN SPINNER. This is the bug.
  expect(sidebarValue).toBe('running')
})

// ---------------------------------------------------------------------------
// FIX: dropStateSubsIfEmpty preserves long-lived state subscribers across a
// kill+respawn so the sidebar/tab dot no longer freezes. T5 is T3 with the fix
// applied at the cleanup step — the orphan is gone and the cb tracks the new
// session to 'idle'.
// ---------------------------------------------------------------------------

test('FIX T4: dropStateSubsIfEmpty keeps sets with subscribers, drops empty/missing', () => {
  const stateSubs = new Map<string, Set<(n: TerminalState, o: TerminalState) => void>>()
  stateSubs.set('keep', new Set([() => {}]))
  stateSubs.set('empty', new Set())

  dropStateSubsIfEmpty(stateSubs, 'keep')
  dropStateSubsIfEmpty(stateSubs, 'empty')
  dropStateSubsIfEmpty(stateSubs, 'missing') // must not throw

  expect(stateSubs.has('keep')).toBe(true)  // long-lived subscriber preserved
  expect(stateSubs.has('empty')).toBe(false) // genuinely-gone session dropped
})

test('FIX T5: with dropStateSubsIfEmpty, sidebar cb survives respawn and tracks idle', () => {
  type PtyState = { lastSeq: number; sessionInvalid: boolean; state: TerminalState }
  const sid = 'task:task'
  const statesRef = new Map<string, PtyState>()
  const stateSubs = new Map<string, Set<(n: TerminalState, o: TerminalState) => void>>()
  const exitSubs = new Map<string, Set<(code: number) => void>>()

  const getOrCreateState = (id: string): PtyState => {
    let s = statesRef.get(id)
    if (!s) { s = { lastSeq: -1, sessionInvalid: false, state: 'starting' }; statesRef.set(id, s) }
    return s
  }
  const onStateChange = (id: string, next: TerminalState): void => {
    const s = getOrCreateState(id)
    const old = s.state
    s.state = next
    stateSubs.get(id)?.forEach((cb) => cb(next, old))
  }

  let sidebarValue: TerminalState | undefined
  const sidebarCb = (next: TerminalState): void => { sidebarValue = next }

  // running
  getOrCreateState(sid).state = 'idle'
  stateSubs.set(sid, new Set([sidebarCb]))
  onStateChange(sid, 'running')
  expect(sidebarValue).toBe('running')

  // resetTaskState then kill+exit — but cleanup now uses the FIX
  statesRef.delete(sid)
  applyExitEvent(sid, -2, statesRef.get(sid), stateSubs, exitSubs)
  dropStateSubsIfEmpty(stateSubs, sid) // FIX: set still has sidebarCb -> preserved

  // new PTY settles to idle; preserved cb receives it
  onStateChange(sid, 'starting')
  onStateChange(sid, 'idle')

  expect(statesRef.get(sid)!.state).toBe('idle')
  expect(sidebarValue).toBe('idle') // FIXED: tracks new session, not frozen on 'running'
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
