/**
 * Cross-task terminal leak detector (terminal-identity.ts): a pane must hold
 * exactly ONE xterm root, tagged with the pane's own session id.
 */
import { expect, test } from 'vitest'
import { findIdentityAnomalies } from './terminal-identity'

const ok = {
  sessionId: 'a:a',
  containerTags: ['a:a'],
  terminalTag: 'a:a',
  terminalInContainer: true
}

test('healthy pane → no anomalies', () => {
  expect(findIdentityAnomalies(ok)).toEqual([])
})

test("another session's xterm in the pane", () => {
  expect(findIdentityAnomalies({ ...ok, containerTags: ['a:a', 'b:b'] })).toEqual([
    'multiple-xterms',
    'foreign-xterm-in-container'
  ])
})

test('the only xterm in the pane belongs to another session', () => {
  expect(findIdentityAnomalies({ ...ok, containerTags: ['b:b'], terminalTag: 'b:b' })).toEqual([
    'foreign-xterm-in-container',
    'terminal-ref-foreign'
  ])
})

test('terminal ref detached from its pane', () => {
  expect(findIdentityAnomalies({ ...ok, containerTags: [], terminalInContainer: false })).toEqual([
    'no-xterm-in-container',
    'terminal-not-in-container'
  ])
})

test('untagged xterm counts as foreign', () => {
  expect(findIdentityAnomalies({ ...ok, containerTags: [null] })).toEqual([
    'foreign-xterm-in-container'
  ])
})

test('no terminal yet (still initializing) → only container is checked', () => {
  expect(
    findIdentityAnomalies({
      sessionId: 'a:a',
      containerTags: [],
      terminalTag: undefined,
      terminalInContainer: false
    })
  ).toEqual([])
})
