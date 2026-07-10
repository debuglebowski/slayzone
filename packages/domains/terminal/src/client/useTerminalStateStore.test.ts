/**
 * Tests for the reactive terminal-state store (pure actions + reconcile).
 * Run with: npx tsx packages/domains/terminal/src/client/useTerminalStateStore.test.ts
 *
 * Importing the store runs its module-init wiring, but that is guarded on
 * `window` so it is a no-op here. We exercise the actions via the non-hook
 * `getState()` API (no React / DOM needed).
 */
import { useTerminalStateStore } from './useTerminalStateStore'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  // Reset state between tests for isolation (actions are preserved by merge).
  useTerminalStateStore.setState({ byId: {}, hibernated: {}, lastPushedAt: {} })
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

const s = () => useTerminalStateStore.getState()

console.log('\nuseTerminalStateStore — applyStateChange / applyExit / applyHibernated\n')

test('applyStateChange sets state; getSessionState defaults to starting', () => {
  expect(s().getSessionState('a:a')).toBe('starting')
  s().applyStateChange('a:a', 'running')
  expect(s().getSessionState('a:a')).toBe('running')
})

test('applyExit transitions to dead', () => {
  s().applyStateChange('b:b', 'running')
  s().applyExit('b:b')
  expect(s().getSessionState('b:b')).toBe('dead')
})

test('applyHibernated synthesizes hibernated + marks the session', () => {
  s().applyStateChange('c:c', 'running')
  s().applyHibernated('c:c')
  expect(s().getSessionState('c:c')).toBe('hibernated')
  expect(s().hibernated['c:c']).toBe(true)
})

test('applyExit preserves hibernated (does NOT flip to dead)', () => {
  s().applyHibernated('d:d')
  s().applyExit('d:d')
  expect(s().getSessionState('d:d')).toBe('hibernated')
})

test('applyStateChange swallows the kill dead while hibernated', () => {
  s().applyHibernated('e:e')
  s().applyStateChange('e:e', 'dead')
  expect(s().getSessionState('e:e')).toBe('hibernated')
})

test('applyStateChange on a non-dead transition clears the hibernated marker (reopen)', () => {
  s().applyHibernated('f:f')
  s().applyStateChange('f:f', 'running')
  expect(s().getSessionState('f:f')).toBe('running')
  expect(s().hibernated['f:f']).toBe(undefined)
})

test('clearSession forgets the session entirely', () => {
  s().applyHibernated('g:g')
  s().clearSession('g:g')
  expect(s().getSessionState('g:g')).toBe('starting')
  expect(s().hibernated['g:g']).toBe(undefined)
})

console.log('\nuseTerminalStateStore — reconcile (self-heal)\n')

test('reconcile adopts a dropped state-change (local running, backend idle)', () => {
  s().applyStateChange('a:a', 'running')
  s().reconcile([{ sessionId: 'a:a', state: 'idle' }])
  expect(s().getSessionState('a:a')).toBe('idle')
})

test('reconcile marks a dropped exit dead (alive locally, absent from list)', () => {
  s().applyStateChange('b:b', 'running')
  s().reconcile([])
  expect(s().getSessionState('b:b')).toBe('dead')
})

test('reconcile never revives a locally-dead session', () => {
  s().applyStateChange('c:c', 'running')
  s().applyExit('c:c')
  s().reconcile([{ sessionId: 'c:c', state: 'idle' }])
  expect(s().getSessionState('c:c')).toBe('dead')
})

test('reconcile skips hibernated — not clobbered to dead when absent', () => {
  s().applyHibernated('d:d')
  s().reconcile([])
  expect(s().getSessionState('d:d')).toBe('hibernated')
})

test('reconcile skips hibernated — a stale list idle does NOT revive it', () => {
  s().applyHibernated('e:e')
  s().reconcile([{ sessionId: 'e:e', state: 'idle' }])
  expect(s().getSessionState('e:e')).toBe('hibernated')
})

test('reconcile fills a missing entry from the list', () => {
  s().reconcile([{ sessionId: 'h:h', state: 'running' }])
  expect(s().getSessionState('h:h')).toBe('running')
})

test('reconcile: respawn-orphan dropped-idle converges (the original bug)', () => {
  // Models the frozen task dot: stuck 'running' in the store, backend long idle.
  s().applyStateChange('task:task', 'running')
  s().reconcile([{ sessionId: 'task:task', state: 'idle' }])
  expect(s().getSessionState('task:task')).toBe('idle')
})

console.log('\nuseTerminalStateStore — reconcile hibernation (cross-window self-heal)\n')

test('reconcile adopts DB hibernated for a stale-idle session (cross-window bug)', () => {
  // The bug: a session that hibernated while another window owned it never got
  // the window-targeted pty:hibernated IPC, so this window shows stale 'idle'.
  // The authoritative DB hibernated set (2nd arg) must heal it to 'hibernated'.
  s().applyStateChange('t:t', 'idle')
  s().reconcile([], ['t:t'])
  expect(s().getSessionState('t:t')).toBe('hibernated')
  expect(s().hibernated['t:t']).toBe(true)
})

test('reconcile: DB hibernated wins over a stale-alive list entry (100ms delete lag)', () => {
  // Right after hibernate the killed session can still linger in session:list
  // for ~100ms. DB is the authority — keep hibernated, ignore the stale 'idle'.
  s().applyStateChange('x:x', 'idle')
  s().reconcile([{ sessionId: 'x:x', state: 'idle' }], ['x:x'])
  expect(s().getSessionState('x:x')).toBe('hibernated')
})

test('reconcile clears hibernated when alive again + dropped from DB set (cross-window reopen)', () => {
  // Reopened in another window: that window got the respawn IPC, this one did
  // not. DB flag cleared + session alive in the list → drop the marker here.
  s().applyHibernated('r:r')
  s().reconcile([{ sessionId: 'r:r', state: 'running' }], [])
  expect(s().getSessionState('r:r')).toBe('running')
  expect(s().hibernated['r:r']).toBe(undefined)
})

test('reconcile keeps hibernated during DB-write lag (absent from list AND set)', () => {
  // pty:hibernated IPC set the local marker, but the async DB write has not
  // landed yet (so the set is empty) and the PTY is already gone from the list.
  // Must NOT clear — only positive alive evidence clears a marker.
  s().applyHibernated('lag:lag')
  s().reconcile([], [])
  expect(s().getSessionState('lag:lag')).toBe('hibernated')
})

console.log('\nuseTerminalStateStore — reconcile dispatch-freshness guard (flicker fix)\n')

test('reconcile skips a stomp when the push landed after the fetch was dispatched (stale snapshot)', () => {
  // Models: hook flips a:a to 'running', a stale in-flight reconcile (dispatched
  // before the hook fired) resolves afterwards with a pre-hook 'idle' snapshot.
  // The stale snapshot must not flicker the dot back to 'idle'.
  s().applyStateChange('a:a', 'running')
  const dispatchedAt = Date.now() - 1000
  s().reconcile([{ sessionId: 'a:a', state: 'idle' }], undefined, dispatchedAt)
  expect(s().getSessionState('a:a')).toBe('running')
})

test('reconcile still applies a snapshot dispatched after the last push (no race)', () => {
  s().applyStateChange('b:b', 'running')
  const dispatchedAt = Date.now() + 1000
  s().reconcile([{ sessionId: 'b:b', state: 'idle' }], undefined, dispatchedAt)
  expect(s().getSessionState('b:b')).toBe('idle')
})

test('reconcile Pass 2 skips marking dead when the alive-push is fresher than the stale fetch', () => {
  s().applyStateChange('c:c', 'running')
  const dispatchedAt = Date.now() - 1000
  s().reconcile([], undefined, dispatchedAt)
  expect(s().getSessionState('c:c')).toBe('running')
})

test('reconcile without dispatchedAt keeps legacy always-stomp behavior', () => {
  s().applyStateChange('d:d', 'running')
  s().reconcile([{ sessionId: 'd:d', state: 'idle' }])
  expect(s().getSessionState('d:d')).toBe('idle')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
