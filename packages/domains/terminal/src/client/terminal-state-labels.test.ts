/**
 * Desktop's status dots (`@slayzone/ui` terminal-state.ts: colour classes + a label
 * per state) and the DOM-free labels every other client shows
 * (`TERMINAL_STATE_LABELS` in terminal-contracts, read by the phone's agent list)
 * must say the same words. `@slayzone/ui` is shared infrastructure and cannot import
 * a domain, so it keeps its own copy; this package sees both and pins them equal.
 */
import { expect, test } from 'vitest'
import { ATTENTION_STATE_STYLE, getTerminalStateStyle } from '@slayzone/ui'
import {
  TERMINAL_STATE_LABELS,
  type TerminalState,
  UNREAD_LABEL
} from '@slayzone/terminal-contracts'

test('every terminal state has the same label on desktop and in the contracts', () => {
  for (const state of Object.keys(TERMINAL_STATE_LABELS) as TerminalState[]) {
    expect(getTerminalStateStyle(state)?.label, state).toBe(TERMINAL_STATE_LABELS[state])
  }
})

test('the unread ("needs attention") label is the same', () => {
  expect(ATTENTION_STATE_STYLE.label).toBe(UNREAD_LABEL)
})
