/**
 * The terminal-state reducers as plain functions (`@slayzone/terminal/terminal-state`):
 * what desktop's zustand store (`useTerminalStateStore`, whose own suite covers every
 * rule through the store) and the phone's agent list both run. Here: the pure
 * contract — a patch from (state, event), the input never mutated, the clock passed in.
 */
import { expect, test } from 'vitest'
import {
  applyExit,
  applyHibernated,
  applyStateChange,
  EMPTY_TERMINAL_STATE,
  hydrate,
  reconcile,
  sessionStateOf,
  type TerminalStateData
} from './terminal-state-reducer'

const apply = (s: TerminalStateData, patch: Partial<TerminalStateData>): TerminalStateData => ({
  ...s,
  ...patch
})

test('a state change is a patch; the input state is never mutated', () => {
  const before = EMPTY_TERMINAL_STATE
  const patch = applyStateChange(before, 'a:a', 'running', 100)
  expect(patch.byId).toEqual({ 'a:a': 'running' })
  expect(patch.lastPushedAt).toEqual({ 'a:a': 100 })
  expect(before.byId).toEqual({})
  expect(sessionStateOf(apply(before, patch), 'a:a')).toBe('running')
})

test('an unknown session reads as starting', () => {
  expect(sessionStateOf(EMPTY_TERMINAL_STATE, 'x:x')).toBe('starting')
})

test('hibernated survives its own kill, flows on a real respawn', () => {
  let s = apply(EMPTY_TERMINAL_STATE, applyHibernated(EMPTY_TERMINAL_STATE, 'h:h', 1))
  s = apply(s, applyExit(s, 'h:h', 2))
  expect(sessionStateOf(s, 'h:h')).toBe('hibernated')
  s = apply(s, applyStateChange(s, 'h:h', 'dead', 3))
  expect(sessionStateOf(s, 'h:h')).toBe('hibernated')
  s = apply(s, applyStateChange(s, 'h:h', 'running', 4))
  expect(sessionStateOf(s, 'h:h')).toBe('running')
})

test('hydrate fills only unknown sessions', () => {
  let s = apply(EMPTY_TERMINAL_STATE, applyStateChange(EMPTY_TERMINAL_STATE, 'a:a', 'running', 1))
  s = apply(
    s,
    hydrate(s, [
      { sessionId: 'a:a', state: 'idle' },
      { sessionId: 'b:b', state: 'idle', backgroundJobs: 2 }
    ])
  )
  expect(sessionStateOf(s, 'a:a')).toBe('running')
  expect(sessionStateOf(s, 'b:b')).toBe('idle')
  expect(s.jobsById['b:b']).toBe(2)
})

test('reconcile: a push newer than the fetch wins over its snapshot', () => {
  let s = apply(EMPTY_TERMINAL_STATE, applyStateChange(EMPTY_TERMINAL_STATE, 'a:a', 'running', 50))
  s = apply(s, reconcile(s, [{ sessionId: 'a:a', state: 'idle' }], undefined, 10))
  expect(sessionStateOf(s, 'a:a')).toBe('running')
  s = apply(s, reconcile(s, [], [], 100))
  expect(sessionStateOf(s, 'a:a')).toBe('dead')
})
