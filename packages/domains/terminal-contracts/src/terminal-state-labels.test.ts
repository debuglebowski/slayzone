/**
 * The words a UI uses for an agent's state. Desktop's dot styles
 * (`@slayzone/ui` terminal-state.ts) carry the same words; that equality is pinned in
 * `@slayzone/terminal` (terminal-state-labels.test.ts), which sees both packages.
 */
import { expect, test } from 'vitest'
import { TERMINAL_STATE_LABELS, UNREAD_LABEL } from './terminal-state-labels.js'
import type { TerminalState } from './types.js'

test('names every terminal state', () => {
  const states: TerminalState[] = [
    'starting',
    'running',
    'background',
    'idle',
    'error',
    'dead',
    'hibernated'
  ]
  expect(Object.keys(TERMINAL_STATE_LABELS).sort()).toEqual([...states].sort())
  for (const state of states) expect(TERMINAL_STATE_LABELS[state]).toMatch(/\S/)
})

test('uses the words desktop shows', () => {
  expect(TERMINAL_STATE_LABELS).toEqual({
    starting: 'Starting',
    running: 'Active',
    background: 'Subagents working',
    idle: 'Idle',
    error: 'Error',
    dead: 'Stopped',
    hibernated: 'Paused'
  })
  expect(UNREAD_LABEL).toBe('Unread')
})
