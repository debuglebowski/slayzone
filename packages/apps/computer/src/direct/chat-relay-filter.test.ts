import { describe, expect, it } from 'vitest'
import { chatSavedSummary } from '@slayzone/terminal-contracts'
import { createChatRelayFilter } from './chat-relay-filter'

describe('chat relay filter', () => {
  it('relays everything until the hub configures it, then only the watched tabs', () => {
    const f = createChatRelayFilter()
    expect(f.wantsFull('a')).toBe(true)
    f.configure(false, ['b'])
    expect(f.wantsFull('a')).toBe(false)
    expect(f.wantsFull('b')).toBe(true)
    f.configure(true, [])
    expect(f.wantsFull('a')).toBe(true)
  })
})

describe('saved-event summary (what the hub always gets)', () => {
  it('keeps the seq and kind, and the fields the hub acts on', () => {
    expect(
      chatSavedSummary({ kind: 'assistant-text', messageId: 'm', text: 'secret' } as never, 4)
    ).toEqual({
      seq: 4,
      kind: 'assistant-text'
    })
    expect(
      chatSavedSummary({ kind: 'user-message', id: 'u1', text: 'prompt text' } as never, 5)
    ).toEqual({
      seq: 5,
      kind: 'user-message',
      id: 'u1'
    })
    expect(
      chatSavedSummary(
        { kind: 'user-message-delivery', id: 'u1', state: 'failed', error: 'x' } as never,
        6
      )
    ).toEqual({ seq: 6, kind: 'user-message-delivery', id: 'u1', state: 'failed', error: 'x' })
  })
})
