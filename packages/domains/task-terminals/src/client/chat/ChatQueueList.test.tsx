// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatAttachment, QueuedChatMessage } from '@slayzone/terminal-contracts'

const mocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../../shared/ui/src/use-stable-callback')),
  ...(await vi.importActual<object>('../../../../../shared/ui/src/tooltip')),
  cn: (...c: unknown[]) => c.filter(Boolean).join(' '),
  toast: mocks.toast
}))
vi.mock('./attachments/AttachmentChip', () => ({
  AttachmentChip: ({
    attachment,
    onRemove
  }: {
    attachment: ChatAttachment
    onRemove: () => void
  }) => (
    <button type="button" onClick={onRemove}>
      chip {attachment.name}
    </button>
  ),
  AttachmentKindIcon: () => null
}))

import { TooltipProvider } from '../../../../../shared/ui/src/tooltip'

// jsdom ships no ResizeObserver; Radix tooltip content measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
import { ChatQueueList, HOLD_RENEW_MS, type ChatQueueListProps } from './ChatQueueList'
import type { QueuedSubmission } from './queued-submissions'

const FILE: ChatAttachment = {
  artifactId: 'a1',
  name: 'red.png',
  kind: 'image',
  mediaType: 'image/png',
  size: 9
}
const q = (id: string, text: string, over: Partial<QueuedChatMessage> = {}): QueuedChatMessage => ({
  id,
  tabId: 'tab-1',
  send: text,
  original: text,
  position: 0,
  createdAt: 'now',
  ...over
})

let props: ChatQueueListProps
function setup(over: Partial<ChatQueueListProps> = {}) {
  props = {
    items: [
      q('q1', 'first'),
      q('q2', 'second', {
        content: [
          { type: 'attachment', attachment: FILE },
          { type: 'text', text: 'second' }
        ]
      })
    ],
    editable: true,
    onRemove: vi.fn(() => Promise.resolve()),
    onMove: vi.fn(() => Promise.resolve()),
    onHold: vi.fn(() => Promise.resolve(true)),
    onRelease: vi.fn(() => Promise.resolve()),
    onSave: vi.fn(() => Promise.resolve(true)),
    onSaveGone: vi.fn(),
    ...over
  }
  return render(
    <TooltipProvider>
      <ChatQueueList {...props} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mocks.toast.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const editBox = () =>
  screen.getByRole('textbox', { name: 'Edit queued message' }) as HTMLTextAreaElement

describe('ChatQueueList', () => {
  it('lists the queue with its count; a message with files shows them', () => {
    setup()
    expect(screen.getByText('Up next · 2')).toBeDefined()
    expect(screen.getByText('first')).toBeDefined()
    expect(screen.getByText('red.png')).toBeDefined()
  })

  it('cancel removes by id', () => {
    setup()
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel queued message' })[1])
    expect(props.onRemove).toHaveBeenCalledWith('q2')
  })

  it('edit: holds the message, Enter saves the new text (files kept) and releases it', async () => {
    setup()
    await act(async () =>
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit queued message' })[1])
    )
    expect(props.onHold).toHaveBeenCalledWith('q2')
    expect(editBox().value).toBe('second')
    fireEvent.change(editBox(), { target: { value: 'second, but better' } })
    await act(async () => fireEvent.keyDown(editBox(), { key: 'Enter' }))
    expect(props.onSave).toHaveBeenCalledWith('q2', 'second, but better', [FILE])
    expect(props.onRelease).toHaveBeenCalledWith('q2')
    expect(screen.queryByRole('textbox', { name: 'Edit queued message' })).toBeNull()
  })

  it('the hold is renewed while the editor is open; Escape cancels and releases', async () => {
    setup()
    await act(async () =>
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit queued message' })[0])
    )
    await act(() => vi.advanceTimersByTimeAsync(HOLD_RENEW_MS + 50))
    expect(props.onHold).toHaveBeenCalledTimes(2)
    await act(async () => fireEvent.keyDown(editBox(), { key: 'Escape' }))
    expect(props.onSave).not.toHaveBeenCalled()
    expect(props.onRelease).toHaveBeenCalledWith('q1')
  })

  it('a message that was sent meanwhile cannot be opened for editing', async () => {
    setup({ onHold: vi.fn(() => Promise.resolve(false)) })
    await act(async () =>
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit queued message' })[0])
    )
    expect(screen.queryByRole('textbox', { name: 'Edit queued message' })).toBeNull()
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/already sent/i))
  })

  it('saving after it was sent anyway: the edit goes to the composer, nothing is lost', async () => {
    setup({ onSave: vi.fn(() => Promise.resolve(false)) })
    await act(async () =>
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit queued message' })[0])
    )
    fireEvent.change(editBox(), { target: { value: 'my edit' } })
    await act(async () => fireEvent.keyDown(editBox(), { key: 'Enter' }))
    expect(props.onSaveGone).toHaveBeenCalledWith('my edit', [])
  })

  it('Alt+↓ / Alt+↑ on a row move it', async () => {
    setup()
    const rows = screen.getAllByTestId('chat-queue-item')
    await act(async () => fireEvent.keyDown(rows[0], { key: 'ArrowDown', altKey: true }))
    expect(props.onMove).toHaveBeenCalledWith('q1', 1)
    await act(async () => fireEvent.keyDown(rows[1], { key: 'ArrowUp', altKey: true }))
    expect(props.onMove).toHaveBeenCalledWith('q2', 0)
  })

  it('not editable (Codex): no edit, no reorder handle; "Stop & send" only when offered', () => {
    setup({ editable: false })
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Drag to reorder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop & send' })).toBeNull()
    cleanup()
    const onSendNow = vi.fn()
    setup({ onSendNow })
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop & send' })[1])
    expect(onSendNow).toHaveBeenCalledWith('q2')
  })

  it('"Send now" only when offered (a turn runs, no prompt waits)', () => {
    setup()
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull()
    cleanup()
    const onSteer = vi.fn()
    setup({ onSteer })
    fireEvent.click(screen.getAllByRole('button', { name: 'Send now' })[1])
    expect(onSteer).toHaveBeenCalledWith('q2')
  })

  it('a message with the agent: marked, no edit / reorder / send actions; cancel only if it can be taken back', () => {
    const items = [q('q1', 'first'), q('q2', 'second', { steering: true })]
    setup({ items, onSteer: vi.fn(), onSendNow: vi.fn(), withdrawSteered: false })
    const row = screen.getAllByTestId('chat-queue-item')[1]
    expect(row.textContent).toContain('With agent')
    expect(row.querySelector('[aria-label="Edit queued message"]')).toBeNull()
    expect(row.querySelector('[aria-label="Drag to reorder"]')).toBeNull()
    expect(row.querySelector('[aria-label="Stop & send"]')).toBeNull()
    expect(row.querySelector('[aria-label="Send now"]')).toBeNull()
    expect(row.querySelector('[aria-label="Cancel queued message"]')).toBeNull()
    cleanup()
    setup({ items, withdrawSteered: true })
    const again = screen.getAllByTestId('chat-queue-item')[1]
    const cancel = again.querySelector('[aria-label="Take back from the agent"]') as HTMLElement
    expect(cancel).not.toBeNull()
    fireEvent.click(cancel)
    expect(props.onRemove).toHaveBeenCalledWith('q2')
  })

  it('every row action explains itself in a tooltip', async () => {
    setup({ onSteer: vi.fn(), onSendNow: vi.fn() })
    const row = screen.getAllByTestId('chat-queue-item')[0]
    const tips: Array<[string, string]> = [
      ['Send now', 'Send now: the agent reads it after its current step'],
      ['Stop & send', 'Stop the agent and send this next'],
      ['Edit queued message', 'Edit'],
      ['Cancel queued message', 'Remove from the queue']
    ]
    for (const [name, tip] of tips) {
      const button = row.querySelector(`[aria-label="${name}"]`) as HTMLElement
      await act(async () => button.focus())
      expect((await screen.findByRole('tooltip')).textContent).toContain(tip)
      await act(async () => button.blur())
    }
  })

  describe('messages not yet confirmed by the hub', () => {
    const pendingEntry = (over: Partial<QueuedSubmission> = {}): QueuedSubmission => ({
      id: 'p1',
      send: 'third',
      original: 'third',
      content: [{ type: 'text', text: 'third' }],
      createdAt: 1,
      state: 'pending',
      ...over
    })

    it('show at once as ordinary rows at the end, with no actions and no waiting text', () => {
      setup({ pending: [pendingEntry()], onSteer: vi.fn(), onSendNow: vi.fn() })
      const rows = screen.getAllByTestId('chat-queue-item')
      expect(rows.map((r) => r.textContent)).toEqual([
        expect.stringContaining('first'),
        expect.stringContaining('second'),
        expect.stringContaining('third')
      ])
      expect(screen.getByText('Up next · 3')).toBeTruthy()
      expect(rows[2].querySelectorAll('button')).toHaveLength(0)
      expect(screen.queryByText(/Waiting for queue confirmation/)).toBeNull()
    })

    it('one the hub already listed is not shown twice', () => {
      setup({ pending: [pendingEntry({ id: 'q2' })] })
      expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(2)
    })

    it('one that failed says why, with Retry and Dismiss', () => {
      const onRetryPending = vi.fn(() => Promise.resolve())
      const onDismissPending = vi.fn(() => Promise.resolve())
      setup({
        items: [],
        pending: [pendingEntry({ state: 'failed', error: 'Computer offline' })],
        onRetryPending,
        onDismissPending
      })
      const row = screen.getByTestId('chat-queue-item')
      expect(row.textContent).toContain('Computer offline')
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(onRetryPending).toHaveBeenCalledWith('p1')
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      expect(onDismissPending).toHaveBeenCalledWith('p1')
    })
  })
})
