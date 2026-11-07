import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '@slayzone/terminal/client'
import type { ChatPinnedMessage } from '@slayzone/terminal-contracts'
import { itemKeyOf } from './timeline-item-key'
import { pinnableRow, pinnedMessageToJumpTo, pinPlace } from './pinned-messages'

const user = (over: Partial<Extract<TimelineItem, { kind: 'user-text' }>> = {}): TimelineItem => ({
  kind: 'user-text',
  id: 'u1',
  text: 'Fix the login bug\nmore detail',
  timestamp: 1,
  ...over
})
const answer = (over: Partial<Extract<TimelineItem, { kind: 'text' }>> = {}): TimelineItem => ({
  kind: 'text',
  role: 'assistant',
  messageId: 'a1',
  text: '## Done\nThe bug is fixed.',
  blockOrdinal: 0,
  timestamp: 2,
  ...over
})
const pin = (
  row: number | undefined,
  over: Partial<ChatPinnedMessage> = {}
): ChatPinnedMessage => ({
  conversationId: 's',
  key: `k${row}`,
  target: 'user',
  messageId: 'u',
  ...(row !== undefined ? { row } : {}),
  excerpt: 'x',
  pinnedAt: 1,
  ...over
})

describe('pinnableRow', () => {
  it('a user message: keyed like its timeline row, its first line as excerpt', () => {
    const item = user()
    expect(pinnableRow(item)).toEqual({
      key: itemKeyOf(item, 0),
      target: 'user',
      messageId: 'u1',
      excerpt: 'Fix the login bug'
    })
  })

  it('an answer: keyed like its timeline row (block too), markdown dropped', () => {
    const item = answer({ blockOrdinal: 2 })
    expect(pinnableRow(item)).toEqual({
      key: itemKeyOf(item, 0),
      target: 'answer',
      messageId: 'a1',
      excerpt: 'Done'
    })
    expect(itemKeyOf(item, 0)).toBe('text:a1:2')
  })

  it('a message of only attachments names them', () => {
    expect(
      pinnableRow(
        user({
          text: '',
          attachments: [
            {
              artifactId: 'x',
              name: 'shot.png',
              kind: 'image',
              mediaType: 'image/png',
              size: 1
            }
          ]
        })
      )?.excerpt
    ).toBe('shot.png')
  })

  it('not pinnable: no id, a sub-agent row, a streaming answer, other kinds', () => {
    expect(pinnableRow(user({ id: undefined }))).toBeNull()
    expect(pinnableRow(user({ parentToolUseId: 't' }))).toBeNull()
    expect(pinnableRow(answer({ parentToolUseId: 't' }))).toBeNull()
    expect(pinnableRow(answer({ stream: 'open' }))).toBeNull()
    expect(
      pinnableRow({
        kind: 'thinking',
        messageId: 'a1',
        text: 'hm',
        hasSignature: false,
        timestamp: 1
      })
    ).toBeNull()
  })
})

describe('pinPlace', () => {
  const branch = {
    row: 9,
    item: {
      kind: 'conversation-branch' as const,
      id: 'b1',
      reason: 'rewound' as const,
      hiddenFrom: 4,
      hiddenCount: 3,
      timestamp: 0
    }
  }
  it('a row in the conversation is here', () => {
    expect(pinPlace(pin(2), new Set([4, 5, 6]), [branch])).toEqual({ inBranch: null })
    expect(pinPlace(pin(undefined), new Set([4]), [branch])).toEqual({ inBranch: null })
  })
  it('a row the conversation rewound away names its branch', () => {
    expect(pinPlace(pin(5), new Set([4, 5, 6]), [branch])).toEqual({ inBranch: 'b1' })
  })
})

describe('pinnedMessageToJumpTo', () => {
  const pins = [pin(30), pin(10), pin(undefined), pin(20)]
  it('next = the first pin below the view; previous = the last above it', () => {
    expect(pinnedMessageToJumpTo(pins, 15, 1)?.row).toBe(20)
    expect(pinnedMessageToJumpTo(pins, 15, -1)?.row).toBe(10)
    expect(pinnedMessageToJumpTo(pins, 30, 1)).toBeNull()
    expect(pinnedMessageToJumpTo(pins, 10, -1)).toBeNull()
  })
})
