// @vitest-environment jsdom
/**
 * Comment on a diff line (chat E, plan 4.4): every chat diff offers it when the
 * provider can take it; the comment goes to the composer via `addDiffComment`.
 */
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

// No syntax worker in jsdom: plain lines.
vi.mock('../../../../../../shared/diff-view/src/highlight', () => ({
  tokenizeContent: () => Promise.resolve([])
}))

import type { FileDiff } from '@slayzone/diff-view'
import { ChatViewContext, type ChatViewState } from '../ChatViewContext'
import { ChatDiffView } from './ChatDiffView'

const diff: FileDiff = {
  path: '/repo/src/app.ts',
  oldPath: null,
  hunks: [
    {
      header: '@@ -1,1 +1,1 @@',
      oldStart: 1,
      oldLen: 1,
      newStart: 1,
      newLen: 1,
      label: '',
      lines: [
        { type: 'delete', content: 'const b = 2', oldLineNo: 2, newLineNo: null },
        { type: 'add', content: 'const b = 22', oldLineNo: null, newLineNo: 2 }
      ]
    }
  ],
  isBinary: false,
  isNew: false,
  isDeleted: false,
  additions: 1,
  deletions: 1
}

function view(extra: Partial<ChatViewState>, children: React.ReactNode) {
  const value: ChatViewState = {
    collapseSignal: 0,
    finalOnly: false,
    fileEditsOpenByDefault: true,
    showMessageMeta: true,
    search: { query: '', caseSensitive: false },
    timeline: [],
    childIndex: new Map(),
    ...extra
  }
  return render(<ChatViewContext.Provider value={value}>{children}</ChatViewContext.Provider>)
}

afterEach(cleanup)

describe('diff line comments', () => {
  it('none where the provider takes none (Codex)', () => {
    view({}, <ChatDiffView diff={diff} />)
    expect(screen.queryAllByTestId('diff-comment-button')).toHaveLength(0)
  })

  it('a line gets a comment: Enter adds it, with the file and the line', async () => {
    const addDiffComment = vi.fn()
    view({ addDiffComment }, <ChatDiffView diff={diff} />)
    const buttons = screen.getAllByTestId('diff-comment-button')
    expect(buttons).toHaveLength(2)
    expect(buttons[1].getAttribute('aria-label')).toBe('Comment on line 2')
    await act(async () => fireEvent.click(buttons[1]))
    const input = await screen.findByTestId('diff-comment-input')
    fireEvent.change(input, { target: { value: 'Rename this.' } })
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect(addDiffComment).toHaveBeenCalledWith({
      path: '/repo/src/app.ts',
      line: expect.objectContaining({
        type: 'add',
        content: 'const b = 22',
        oldLineNo: null,
        newLineNo: 2
      }),
      comment: 'Rename this.'
    })
    expect(screen.queryByTestId('diff-comment-input')).toBeNull()
  })

  it('Shift+Enter is a new line; an empty comment is not added; Esc cancels', async () => {
    const addDiffComment = vi.fn()
    view({ addDiffComment }, <ChatDiffView diff={diff} />)
    await act(async () => fireEvent.click(screen.getAllByTestId('diff-comment-button')[0]))
    const input = await screen.findByTestId('diff-comment-input')
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect(addDiffComment).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'x' } })
    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    input.dispatchEvent(shiftEnter)
    expect(shiftEnter.defaultPrevented).toBe(false)
    expect(addDiffComment).not.toHaveBeenCalled()
    await act(async () => fireEvent.keyDown(input, { key: 'Escape' }))
    expect(screen.queryByTestId('diff-comment-input')).toBeNull()
    expect(addDiffComment).not.toHaveBeenCalled()
  })
})
