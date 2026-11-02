import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '@slayzone/terminal/client'
import { selectTurnOutline, turnToJumpTo } from './turn-outline'

const user = (id: string, text: string, extra: object = {}): TimelineItem =>
  ({ kind: 'user-text', id, text, timestamp: 1_000, ...extra }) as TimelineItem
const reply = (id: string): TimelineItem =>
  ({ kind: 'text', role: 'assistant', messageId: id, text: 'ok', timestamp: 2_000 }) as TimelineItem
const result = (isError = false): TimelineItem =>
  ({ kind: 'result', isError, timestamp: 3_000 }) as unknown as TimelineItem
const key = (item: TimelineItem, i: number) =>
  item.kind === 'user-text' && item.id ? `user-text:${item.id}` : `${item.kind}:${i}`

describe('selectTurnOutline', () => {
  it('one entry per user turn: its first line, index and key', () => {
    const items = [
      { kind: 'session-start', timestamp: 0 } as unknown as TimelineItem,
      user('a', '  Fix the login bug\n\nwith more detail'),
      reply('m1'),
      result(),
      user('b', 'Then break it'),
      { kind: 'turn-error', text: 'API error', timestamp: 0 } as TimelineItem,
      result(true),
      user('c', 'Stop this one'),
      reply('m3'),
      { kind: 'interrupted', timestamp: 0 } as TimelineItem,
      user('d', 'And now?'),
      reply('m4')
    ]
    expect(selectTurnOutline(items, key).map((t) => [t.title, t.index, t.key])).toEqual([
      ['Fix the login bug', 1, 'user-text:a'],
      ['Then break it', 4, 'user-text:b'],
      ['Stop this one', 7, 'user-text:c'],
      ['And now?', 10, 'user-text:d']
    ])
  })

  it('placeOf: entries standing in for rows not loaded take their placeholder index and row', () => {
    const items = [user('a', 'one'), user('b', 'two')]
    const turns = selectTurnOutline(items, key, { placeOf: (i) => ({ index: 0, row: 10 + i }) })
    expect(turns.map((t) => [t.index, t.row])).toEqual([
      [0, 10],
      [0, 11]
    ])
  })

  it('a message with only attachments is titled by them; an empty one gets a placeholder', () => {
    const items = [
      user('a', '', { attachments: [{ kind: 'image', name: 'shot.png' }] }),
      user('b', '   ')
    ]
    expect(selectTurnOutline(items, key).map((t) => t.title)).toEqual([
      'shot.png',
      '(empty message)'
    ])
  })
})

describe('turnToJumpTo', () => {
  const starts = [2, 10, 30]
  it('next: the first turn below the top row', () => {
    expect(turnToJumpTo(starts, 0, 1)).toBe(2)
    expect(turnToJumpTo(starts, 2, 1)).toBe(10)
    expect(turnToJumpTo(starts, 15, 1)).toBe(30)
    expect(turnToJumpTo(starts, 30, 1)).toBeNull()
  })
  it('prev: the start of the turn the top row is in, else the one before', () => {
    expect(turnToJumpTo(starts, 15, -1)).toBe(10)
    expect(turnToJumpTo(starts, 10, -1)).toBe(2)
    expect(turnToJumpTo(starts, 2, -1)).toBeNull()
    expect(turnToJumpTo([], 5, -1)).toBeNull()
  })
})
