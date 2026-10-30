// @vitest-environment jsdom
/**
 * Esc Esc / the palette's Rewind… open a list of the conversation's messages
 * (chat E, plan 4.6) — the TUI's message selector. Picking one starts the
 * action on it (edit & resend for Esc Esc), whose dialog then asks what to
 * restore.
 */
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { RewindPicker } from './RewindPicker'
import type { ConversationActionsView } from './useConversationActions'

beforeAll(() => {
  // cmdk scrolls its selected row into view and measures its list; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn()
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})
afterEach(cleanup)

const user = (id: string, text: string): Extract<TimelineItem, { kind: 'user-text' }> => ({
  kind: 'user-text',
  id,
  text,
  timestamp: Date.now() - 60_000,
  delivery: 'answered'
})

function view(
  active: string[]
): ConversationActionsView & { begin: Mock<ConversationActionsView['begin']> } {
  return {
    canRewind: true,
    canFork: true,
    activeIds: new Set(active),
    lastActiveId: active.at(-1) ?? null,
    busy: false,
    begin: vi.fn<ConversationActionsView['begin']>()
  }
}

describe('RewindPicker', () => {
  // The rows of the user messages (`activeUserRows`); u3 is not active.
  const timeline = [
    user('u1', 'first question'),
    user('u2', 'second question\nwith a second line'),
    user('u3', 'folded away')
  ].map((item, row) => ({ row, item }))

  it('lists the messages the conversation holds, newest first', () => {
    render(
      <RewindPicker
        kind="edit"
        activeUsers={timeline}
        view={view(['u1', 'u2'])}
        onClose={() => {}}
      />
    )
    const rows = screen.getAllByTestId('rewind-picker-item')
    expect(rows.map((r) => r.getAttribute('data-message-id'))).toEqual(['u2', 'u1'])
    expect(rows[0].textContent).toContain('second question')
    expect(rows[0].textContent).not.toContain('with a second line')
  })

  it('Enter picks the selected one: the action starts on it, the list closes', () => {
    const v = view(['u1', 'u2'])
    const onClose = vi.fn()
    render(<RewindPicker kind="edit" activeUsers={timeline} view={v} onClose={onClose} />)
    const input = screen.getByTestId('rewind-picker-input')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onClose).toHaveBeenCalled()
    expect(v.begin).toHaveBeenCalledWith('edit', {
      id: 'u1',
      text: 'first question'
    })
  })

  it('typing filters; fork mode says so', () => {
    const v = view(['u1', 'u2'])
    render(<RewindPicker kind="fork" activeUsers={timeline} view={v} onClose={() => {}} />)
    expect(screen.getByRole('dialog').textContent).toContain('Fork')
    fireEvent.change(screen.getByTestId('rewind-picker-input'), { target: { value: 'first' } })
    expect(screen.getAllByTestId('rewind-picker-item').map((r) => r.textContent)).toEqual([
      expect.stringContaining('first question')
    ])
  })

  it('closed when there is no kind', () => {
    render(
      <RewindPicker kind={null} activeUsers={timeline} view={view(['u1'])} onClose={() => {}} />
    )
    expect(screen.queryByTestId('rewind-picker-item')).toBeNull()
  })
})
