import { describe, expect, it, vi } from 'vitest'
import { turnOutlinePaletteCommands } from './turn-outline-palette'
import type { TurnEntry } from './turn-outline'

const turn = (i: number, title: string, status: TurnEntry['status'] = 'done'): TurnEntry => ({
  key: `user-text:u${i}`,
  index: i * 3,
  title,
  timestamp: 0,
  status
})

describe('turn outline in the Cmd+K palette', () => {
  it('"Go to turn…" lists every turn; picking one reveals it at the top', () => {
    const reveal = vi.fn()
    const jump = vi.fn()
    const commands = turnOutlinePaletteCommands({
      turns: [turn(0, 'Fix the login bug'), turn(1, 'Then break it', 'error')],
      reveal,
      jump
    })
    const goTo = commands.find((c) => c.id === 'chat-turn-goto')!
    expect(goTo.page?.kind).toBe('list')
    const items = goTo.page && 'items' in goTo.page ? goTo.page.items : []
    expect(items.map((i) => i.label)).toEqual(['1. Fix the login bug', '2. Then break it'])
    void items[1].run?.()
    expect(reveal).toHaveBeenCalledWith('user-text:u1', { align: 'start' })
  })

  it('previous / next turn run the outline keys', () => {
    const jump = vi.fn()
    const commands = turnOutlinePaletteCommands({
      turns: [turn(0, 'a'), turn(1, 'b')],
      reveal: vi.fn(),
      jump
    })
    void commands.find((c) => c.id === 'chat-turn-prev')!.run?.()
    void commands.find((c) => c.id === 'chat-turn-next')!.run?.()
    expect(jump.mock.calls).toEqual([[-1], [1]])
  })

  it('nothing without a user turn', () => {
    expect(turnOutlinePaletteCommands({ turns: [], reveal: vi.fn(), jump: vi.fn() })).toEqual([])
  })
})
