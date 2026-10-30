// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { ChatViewContext, type ChatViewState } from './ChatViewContext'
import { RewindDialog } from './RewindDialog'
import { UserMessageActions } from './UserMessageActions'
import { ConversationBranchRow } from './ConversationBranchRow'
import type { ConversationActionsDialog, ConversationActionsView } from './useConversationActions'

afterEach(cleanup)

const user = (text: string, id?: string): Extract<TimelineItem, { kind: 'user-text' }> => ({
  kind: 'user-text',
  text,
  timestamp: 0,
  ...(id ? { id } : {})
})

function withView(view: Partial<ChatViewState>, node: React.ReactNode) {
  const value = {
    collapseSignal: 0,
    finalOnly: false,
    fileEditsOpenByDefault: false,
    showMessageMeta: false,
    search: { query: '', caseSensitive: false },
    timeline: [],
    childIndex: new Map(),
    ...view
  } as ChatViewState
  return render(<ChatViewContext.Provider value={value}>{node}</ChatViewContext.Provider>)
}

function conversation(over: Partial<ConversationActionsView> = {}): ConversationActionsView {
  return {
    canRewind: true,
    canFork: true,
    activeIds: new Set(['u1', 'u2']),
    lastActiveId: 'u2',
    busy: false,
    begin: vi.fn(),
    ...over
  }
}

describe('UserMessageActions', () => {
  it('offers edit, rewind and fork on a message the conversation holds', () => {
    const conv = conversation()
    withView({ conversation: conv }, <UserMessageActions item={user('one', 'u1')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to here' }))
    expect(conv.begin).toHaveBeenCalledWith('rewind', { id: 'u1', text: 'one' })
    expect(screen.getByRole('button', { name: 'Edit & resend' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fork from here' })).toBeTruthy()
  })

  it('no "rewind to here" on the newest message; nothing on a folded one; a note on an id-less one', () => {
    withView({ conversation: conversation() }, <UserMessageActions item={user('two', 'u2')} />)
    expect(screen.queryByRole('button', { name: 'Rewind to here' })).toBeNull()
    cleanup()
    withView({ conversation: conversation() }, <UserMessageActions item={user('gone', 'u9')} />)
    expect(screen.queryByTestId('user-message-actions')).toBeNull()
    cleanup()
    withView({ conversation: conversation() }, <UserMessageActions item={user('old')} />)
    expect(screen.getByText('No rewind for older messages')).toBeTruthy()
  })

  it('nothing at all for a provider without rewind', () => {
    withView({}, <UserMessageActions item={user('one', 'u1')} />)
    expect(screen.queryByTestId('user-message-actions')).toBeNull()
  })
})

function dialog(over: Partial<ConversationActionsDialog> = {}): ConversationActionsDialog {
  return {
    pending: { kind: 'rewind', messageId: 'u1', text: 'one' },
    preview: {
      status: 'ready',
      value: { canRewind: true, filesChanged: ['/r/a.txt'], insertions: 3, deletions: 1 }
    },
    busy: false,
    confirm: vi.fn(),
    cancel: vi.fn(),
    ...over
  }
}

describe('RewindDialog', () => {
  it('rewind to here: conversation and code by default, with the dry run and the Bash caveat', () => {
    const d = dialog()
    render(<RewindDialog dialog={d} />)
    expect(screen.getByTestId('rewind-files').textContent).toContain('1 file would change')
    expect(screen.getByTestId('rewind-files').textContent).toContain('+3 −1')
    expect(screen.getByTestId('rewind-files').textContent).toContain(
      'shell commands are not restored'
    )
    fireEvent.click(screen.getByLabelText('Code only'))
    fireEvent.click(screen.getByTestId('rewind-confirm'))
    expect(d.confirm).toHaveBeenCalledWith('code')
  })

  it('no checkpoint: only the conversation can be rewound, and the reason shows', () => {
    const d = dialog({
      pending: { kind: 'edit', messageId: 'u1', text: 'one' },
      preview: {
        status: 'ready',
        value: {
          canRewind: false,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          error: 'No file checkpoint found for this message.'
        }
      }
    })
    render(<RewindDialog dialog={d} />)
    expect((screen.getByLabelText('Conversation and code') as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByLabelText('Code only')).toBeNull()
    expect(screen.getByTestId('rewind-files').textContent).toContain('No file checkpoint found')
    fireEvent.click(screen.getByTestId('rewind-confirm'))
    expect(d.confirm).toHaveBeenCalledWith('conversation')
  })

  it('waits for the dry run before confirming', () => {
    render(<RewindDialog dialog={dialog({ preview: { status: 'loading' } })} />)
    expect((screen.getByTestId('rewind-confirm') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ConversationBranchRow', () => {
  it('shows what was folded and toggles it', () => {
    const toggle = vi.fn()
    withView(
      { branches: { isOpen: () => false, toggle } },
      <ConversationBranchRow
        item={{
          kind: 'conversation-branch',
          id: 'branch-4',
          reason: 'switched',
          source: 'terminal',
          hiddenFrom: 0,
          hiddenCount: 4,
          timestamp: 0
        }}
      />
    )
    expect(screen.getByText('Continued from the terminal')).toBeTruthy()
    fireEvent.click(screen.getByTestId('chat-branch-toggle'))
    expect(toggle).toHaveBeenCalledWith('branch-4')
  })
})
