/**
 * A message the agent took into its RUNNING turn ("Send now",
 * `user-message` with `joinsTurn`): its row sits where the agent read it, and the
 * turn stays one turn — no healed "interrupted" before it, one result ends it.
 */
import { expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { initialState, isInFlight, reducer, type TimelineItem } from './chat-timeline'

const run = (events: AgentEvent[]) => reducer(initialState(), { type: 'events', events })
const rows = (s: { timeline: ReadonlyArray<TimelineItem | undefined> }) =>
  s.timeline as TimelineItem[]

const result: AgentEvent = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 1,
  durationApiMs: 1,
  numTurns: 1,
  totalCostUsd: 0,
  stopReason: null,
  terminalReason: null,
  text: 'done',
  modelUsage: {},
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials: []
}

const turnUpToTool: AgentEvent[] = [
  { kind: 'user-message', id: 'u1', text: 'run the build' },
  { kind: 'tool-call', id: 't-1', name: 'Bash', input: {} },
  { kind: 'tool-result', toolUseId: 't-1', isError: false, rawContent: 'ok', structured: null }
]

test('a joined message is a row in the running turn, not a new turn', () => {
  const s = run([
    ...turnUpToTool,
    { kind: 'user-message', id: 's1', text: 'also run lint', joinsTurn: true }
  ])
  expect(rows(s).map((r) => r.kind)).not.toContain('interrupted')
  expect(rows(s).at(-1)).toMatchObject({ kind: 'user-text', id: 's1', text: 'also run lint' })
  expect(isInFlight(s)).toBe(true)

  const ended = reducer(s, {
    type: 'events',
    events: [{ kind: 'assistant-text', messageId: 'm2', text: 'lint ok' }, result]
  })
  expect(isInFlight(ended)).toBe(false)
})

test('without the flag the same message would be read as a crashed turn (control)', () => {
  const s = run([...turnUpToTool, { kind: 'user-message', id: 's1', text: 'also run lint' }])
  expect(rows(s).map((r) => r.kind)).toContain('interrupted')
})
