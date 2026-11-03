import { expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { initialState, reducer } from './chat-timeline'
import { chatTranscriptFromEvents, formatChatTranscript, transcriptRows } from './chat-transcript'

const user = (id: string, text: string): AgentEvent =>
  ({ kind: 'user-message', id, text, content: [{ type: 'text', text }] }) as AgentEvent
const said = (messageId: string, text: string): AgentEvent =>
  ({ kind: 'assistant-text', messageId, text }) as AgentEvent
const tool = (id: string, name: string, input: unknown): AgentEvent =>
  ({ kind: 'tool-call', id, name, input }) as AgentEvent
const toolResult = (toolUseId: string, rawContent: string, isError = false): AgentEvent =>
  ({ kind: 'tool-result', toolUseId, isError, rawContent, structured: null }) as AgentEvent
const done = (text: string): AgentEvent =>
  ({
    kind: 'result',
    subtype: 'success',
    isError: false,
    durationMs: 10,
    totalCostUsd: 0.01,
    numTurns: 1,
    text
  }) as AgentEvent

const history = [
  user('u1', 'list files'),
  said('m1', 'Listing them.'),
  tool('t1', 'Bash', { command: 'ls -la' }),
  toolResult('t1', 'a\nb'),
  said('m2', 'Two files.'),
  done('Two files.')
]

test('rows: one per message, tool and turn end, numbered by timeline position', () => {
  const rows = chatTranscriptFromEvents(history)
  expect(rows.map((r) => [r.role, r.text])).toEqual([
    ['user', 'list files'],
    ['assistant', 'Listing them.'],
    ['tool', 'Bash: ls -la'],
    ['assistant', 'Two files.'],
    ['status', 'turn done']
  ])
  expect(rows.map((r) => r.row)).toEqual([...rows.map((r) => r.row)].sort((a, b) => a - b))
  // fork / rewind address user messages by id.
  expect(rows[0].messageId).toBe('u1')
})

test('since / last window the rows', () => {
  const rows = chatTranscriptFromEvents(history)
  const second = rows[1].row
  expect(chatTranscriptFromEvents(history, { since: second }).map((r) => r.text)).toEqual([
    'Bash: ls -la',
    'Two files.',
    'turn done'
  ])
  expect(chatTranscriptFromEvents(history, { last: 2 }).map((r) => r.text)).toEqual([
    'Two files.',
    'turn done'
  ])
})

test('verbose adds thinking and tool results', () => {
  const rows = chatTranscriptFromEvents(
    [
      user('u1', 'hi'),
      { kind: 'assistant-thinking', messageId: 'm1', text: 'hmm' } as AgentEvent,
      tool('t1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('t1', 'boom', true)
    ],
    { verbose: true }
  )
  expect(rows.map((r) => [r.role, r.text])).toEqual([
    ['user', 'hi'],
    ['thinking', 'hmm'],
    ['tool', 'Read: /repo/a.ts\n  → error: boom']
  ])
})

test('rows a rewind folded away are left out', () => {
  let state = initialState()
  state = reducer(state, { type: 'events', events: history })
  const rows = transcriptRows(state, {})
  expect(rows.length).toBeGreaterThan(0)
  expect(transcriptRows(initialState(), {})).toEqual([])
})

test('text format: role prefix, continuation lines indented', () => {
  const text = formatChatTranscript([
    { row: 0, role: 'user', text: 'a\nb' },
    { row: 1, role: 'assistant', text: 'c' }
  ])
  expect(text).toBe('> a\n  b\n\nc\n')
})
