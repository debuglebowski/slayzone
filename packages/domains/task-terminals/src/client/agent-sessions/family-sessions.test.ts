/**
 * The Claude family's Sessions list (chat A, plan 3.6): the chat's and the
 * terminal's sessions in one list, one row per conversation.
 */
import { expect, test } from 'vitest'
import { mergeFamilySessions } from './family-sessions'
import type { TaskSessionRow } from './TaskSessionsSource'

const row = (conversationId: string, over: Partial<TaskSessionRow> = {}): TaskSessionRow => ({
  conversationId,
  origin: 'slay-spawned-fresh',
  startedAt: 1000,
  lastActiveAt: 1000,
  messageCount: 1,
  firstPrompt: conversationId,
  isCurrent: false,
  ...over
})

test('ordered by when the session started, newest first — a switch does not move a card', () => {
  const rows = mergeFamilySessions({
    mode: 'claude-code',
    own: [
      row('A', { startedAt: 1000, lastActiveAt: 9000, isCurrent: true }),
      row('B', { startedAt: 2000, lastActiveAt: 2000 }),
      row('C', { startedAt: 3000, lastActiveAt: 3000 })
    ],
    partner: 'claude-chat',
    other: [row('X', { startedAt: 2500, lastActiveAt: 2500 })]
  })
  expect(rows.map((r) => r.conversationId)).toEqual(['C', 'X', 'B', 'A'])
  expect(rows.map((r) => r.mode)).toEqual([
    'claude-code',
    'claude-chat',
    'claude-code',
    'claude-code'
  ])
  expect(rows.find((r) => r.conversationId === 'A')?.isCurrent).toBe(true)
})

test('a handed-over conversation shows once: under the mode that ran it last, from its first start', () => {
  const rows = mergeFamilySessions({
    mode: 'claude-chat',
    own: [row('H', { startedAt: 5000, lastActiveAt: 6000, isCurrent: true })],
    partner: 'claude-code',
    other: [row('H', { startedAt: 1000, lastActiveAt: 4000, isCurrent: true })]
  })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    mode: 'claude-chat',
    startedAt: 1000,
    lastActiveAt: 6000,
    isCurrent: true
  })
})

test("the partner's current session is not this mode's current one", () => {
  const rows = mergeFamilySessions({
    mode: 'claude-chat',
    own: [],
    partner: 'claude-code',
    other: [row('T', { isCurrent: true })]
  })
  expect(rows[0].isCurrent).toBe(false)
})
