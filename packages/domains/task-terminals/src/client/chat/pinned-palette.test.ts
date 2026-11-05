import { describe, expect, it, vi } from 'vitest'
import type { ChatPinnedMessage } from '@slayzone/terminal-contracts'
import { pinnedMessagePaletteCommands } from './pinned-palette'

const pin = (key: string, excerpt: string, target: 'user' | 'answer'): ChatPinnedMessage => ({
  conversationId: 's',
  key,
  target,
  messageId: key,
  excerpt,
  pinnedAt: 1
})

describe('pinned messages in the Cmd+K palette', () => {
  it('"Go to pinned message…" lists every pin newest first; picking one goes to it', () => {
    const go = vi.fn()
    const pins = [
      pin('user-text:u1', 'Fix the login bug', 'user'),
      pin('text:a1', 'Done', 'answer')
    ]
    const commands = pinnedMessagePaletteCommands({ pins, go, jump: vi.fn() })
    const goTo = commands.find((c) => c.id === 'chat-pinned-goto')!
    const items = goTo.page && 'items' in goTo.page ? goTo.page.items : []
    expect(items.map((i) => i.label)).toEqual(['Answer: Done', 'You: Fix the login bug'])
    void items[1].run?.()
    expect(go).toHaveBeenCalledWith(pins[0])
  })

  it('previous / next pinned message jump', () => {
    const jump = vi.fn()
    const commands = pinnedMessagePaletteCommands({
      pins: [pin('k', 'x', 'user')],
      go: vi.fn(),
      jump
    })
    void commands.find((c) => c.id === 'chat-pinned-prev')!.run?.()
    void commands.find((c) => c.id === 'chat-pinned-next')!.run?.()
    expect(jump.mock.calls).toEqual([[-1], [1]])
  })

  it('nothing without a pin', () => {
    expect(pinnedMessagePaletteCommands({ pins: [], go: vi.fn(), jump: vi.fn() })).toEqual([])
  })
})
