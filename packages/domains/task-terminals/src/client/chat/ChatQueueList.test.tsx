// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatAttachment, QueuedChatMessage } from '@slayzone/terminal-contracts'

const mocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../../shared/ui/src/use-stable-callback')),
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

import { ChatQueueList, HOLD_RENEW_MS, type ChatQueueListProps } from './ChatQueueList'

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
  return render(<ChatQueueList {...props} />)
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

  it('not editable (Codex): no edit, no reorder handle; "send now" only when offered', () => {
    setup({ editable: false })
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Drag to reorder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull()
    cleanup()
    const onSendNow = vi.fn()
    setup({ onSendNow })
    fireEvent.click(screen.getAllByRole('button', { name: 'Send now' })[1])
    expect(onSendNow).toHaveBeenCalledWith('q2')
  })
})
