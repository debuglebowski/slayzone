// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ArtifactRef } from '@slayzone/editor/hooks'
import type { QueuedChatMessage } from '@slayzone/terminal-contracts'
import type { ChatActions, NavigateActions } from './autocomplete/types'

const mocks = vi.hoisted(() => {
  const queue = {
    items: [] as QueuedChatMessage[],
    push: vi.fn<(send: string, original: string) => Promise<void>>(),
    remove: vi.fn<(id: string) => Promise<void>>(),
    clear: vi.fn<() => Promise<void>>()
  }
  return {
    toast: vi.fn(),
    queue,
    history: { entries: [] as string[], record: vi.fn<(text: string) => void>() },
    useChatQueue: vi.fn((_tabId: string, _onDrained?: (original: string) => void) => queue),
    autocomplete: {
      show: false,
      active: null,
      selectedIndex: 0,
      setSelectedIndex: vi.fn(),
      accept: vi.fn(),
      close: vi.fn(),
      handleKeyDown: vi.fn<(e: unknown) => boolean>(),
      transformSubmit: vi.fn<(draft: string) => { send: string } | null>(),
      bumpUsageFromMessage: vi.fn<(text: string) => Promise<void>>()
    }
  }
})

vi.mock('../trpc', () => ({
  useTRPCClient: () => ({
    chat: {
      listSkills: { query: () => Promise.resolve([]) },
      listCommands: { query: () => Promise.resolve([]) },
      listAgents: { query: () => Promise.resolve([]) },
      listFiles: { query: () => Promise.resolve([]) }
    }
  })
}))
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../../shared/ui/src/use-stable-callback')),
  toast: mocks.toast
}))
// Backend-persisted queue (react-query + subscriptions): a plain controllable stand-in.
vi.mock('./useChatQueue', () => ({ useChatQueue: mocks.useChatQueue }))
// Prompt history reads stored prompts through react-query: same treatment.
vi.mock('./usePromptHistory', () => ({ usePromptHistory: () => mocks.history }))
// The autocomplete is a seam here: the composer only consumes handleKeyDown,
// transformSubmit and bumpUsageFromMessage. The sources keep importing the real helpers.
vi.mock('./autocomplete/useAutocomplete', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAutocomplete: () => mocks.autocomplete
}))

import { useChatComposer, type UseChatComposerOpts } from './useChatComposer'

const sendMessage = vi.fn<(text: string) => Promise<void>>()
const abortAndPop = vi.fn<() => Promise<{ popped: boolean; text: string | null }>>()
const getArtifactFilePath = vi.fn<(id: string) => Promise<string | null>>()
const scrollToBottom = vi.fn<() => void>()
const handleEffortChange = vi.fn<(next: string) => Promise<void>>()
const handleModelChange = vi.fn<(next: string) => Promise<void>>()

const IMG_A: ArtifactRef = { id: 'a', title: 'a.png' }
const IMG_B: ArtifactRef = { id: 'b', title: 'b.png' }
const PATHS: Record<string, string> = { a: '/abs/a.png', b: '/abs/b.png' }

let composer: ReturnType<typeof useChatComposer>

/** Mirrors ChatComposer: the hook's ref sits on the real textarea. */
function Harness(props: UseChatComposerOpts) {
  const c = useChatComposer(props)
  composer = c
  const { textareaRef, draft, setDraft, onKeyDown } = c
  return (
    <textarea
      aria-label="Message"
      ref={textareaRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
    />
  )
}

const opts = (over: Partial<UseChatComposerOpts> = {}): UseChatComposerOpts => ({
  tabId: 'tab-1',
  taskId: 'task-1',
  mode: 'claude-chat',
  cwd: '/repo',
  isActive: false,
  sendMessage,
  inFlight: false,
  sessionEnded: false,
  abortAndPop,
  chatApi: {} as ChatActions,
  navigate: {} as NavigateActions,
  getArtifactFilePath,
  scrollToBottom,
  handleEffortChange,
  handleModelChange,
  cliCommands: null,
  ...over
})

function setup(over: Partial<UseChatComposerOpts> = {}) {
  const view = render(<Harness {...opts(over)} />)
  return {
    rerender: (next: Partial<UseChatComposerOpts>) => view.rerender(<Harness {...opts(next)} />)
  }
}

const type = (text: string) => act(() => composer.setDraft(text))
const attach = (refs: ArtifactRef[]) => act(() => composer.setAttachments(refs))
const send = () => act(() => composer.handleSend())
const stop = () => act(() => composer.handleStop())
const textarea = () => screen.getByLabelText('Message') as HTMLTextAreaElement

beforeEach(() => {
  mocks.toast.mockReset()
  mocks.queue.items = []
  mocks.queue.push.mockReset().mockResolvedValue(undefined)
  mocks.queue.remove.mockReset().mockResolvedValue(undefined)
  mocks.queue.clear.mockReset().mockResolvedValue(undefined)
  mocks.useChatQueue.mockClear()
  mocks.autocomplete.handleKeyDown.mockReset().mockReturnValue(false)
  mocks.autocomplete.transformSubmit.mockReset().mockReturnValue(null)
  mocks.autocomplete.bumpUsageFromMessage.mockReset().mockResolvedValue(undefined)
  sendMessage.mockReset().mockResolvedValue(undefined)
  abortAndPop.mockReset().mockResolvedValue({ popped: false, text: null })
  getArtifactFilePath.mockReset().mockImplementation((id) => Promise.resolve(PATHS[id] ?? null))
  scrollToBottom.mockReset()
  handleEffortChange.mockReset().mockResolvedValue(undefined)
  handleModelChange.mockReset().mockResolvedValue(undefined)
  mocks.history.entries = []
  mocks.history.record.mockReset()
})

afterEach(cleanup)

describe('useChatComposer handleSend guards', () => {
  it('does nothing once the session has ended', async () => {
    setup({ sessionEnded: true })
    type('hello')
    await send()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer.draft).toBe('hello')
  })

  it('does nothing for a whitespace-only draft without attachments', async () => {
    setup()
    type('   ')
    await send()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(mocks.queue.push).not.toHaveBeenCalled()
  })
})

describe('useChatComposer /effort builtin', () => {
  it('a valid level switches effort, clears the draft and sends nothing', async () => {
    setup()
    type('/effort high')
    await send()
    expect(handleEffortChange).toHaveBeenCalledWith('high')
    expect(mocks.toast).toHaveBeenCalledWith('Effort set to high')
    expect(composer.draft).toBe('')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('the level is case-insensitive', async () => {
    setup()
    type('/effort MAX')
    await send()
    expect(handleEffortChange).toHaveBeenCalledWith('max')
  })

  it('an invalid level toasts the valid set and keeps the draft', async () => {
    setup()
    type('/effort turbo')
    await send()
    expect(mocks.toast).toHaveBeenCalledWith(
      'Invalid effort level "turbo". Use: low, medium, high, xhigh, max'
    )
    expect(handleEffortChange).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer.draft).toBe('/effort turbo')
  })
})

describe('useChatComposer send', () => {
  it('sends the trimmed draft, clears it and scrolls to the bottom', async () => {
    setup()
    type('  hello  ')
    scrollToBottom.mockClear()
    await send()
    expect(sendMessage).toHaveBeenCalledWith('hello')
    expect(composer.draft).toBe('')
    expect(scrollToBottom).toHaveBeenCalled()
  })

  it('sends the autocomplete-transformed text', async () => {
    mocks.autocomplete.transformSubmit.mockReturnValue({ send: 'expanded template' })
    setup()
    type('/cmd arg')
    await send()
    expect(mocks.autocomplete.transformSubmit).toHaveBeenCalledWith('/cmd arg')
    expect(sendMessage).toHaveBeenCalledWith('expanded template')
  })

  it('bumps autocomplete usage with the raw text, only after sendMessage resolves', async () => {
    let resolveSend = () => {}
    sendMessage.mockReturnValue(
      new Promise<void>((r) => {
        resolveSend = r
      })
    )
    mocks.autocomplete.transformSubmit.mockReturnValue({ send: 'expanded template' })
    setup()
    type('/cmd arg')
    const pending = send()
    expect(mocks.autocomplete.bumpUsageFromMessage).not.toHaveBeenCalled()
    resolveSend()
    await pending
    expect(mocks.autocomplete.bumpUsageFromMessage).toHaveBeenCalledWith('/cmd arg')
  })

  it('prepends resolved image attachments as markdown, then a blank line, then the text', async () => {
    setup()
    attach([IMG_A, IMG_B])
    type('look at these')
    await send()
    expect(sendMessage).toHaveBeenCalledWith(
      '![a.png](/abs/a.png)\n![b.png](/abs/b.png)\n\nlook at these'
    )
    expect(composer.attachments).toEqual([])
  })

  it('sends attachments alone when the draft is empty', async () => {
    setup()
    attach([IMG_A])
    await send()
    expect(sendMessage).toHaveBeenCalledWith('![a.png](/abs/a.png)')
  })

  it('skips attachments that no longer resolve, with a singular toast', async () => {
    setup()
    attach([IMG_A, { id: 'gone', title: 'gone.png' }])
    type('hi')
    await send()
    expect(mocks.toast).toHaveBeenCalledWith('1 image no longer available — skipping')
    expect(sendMessage).toHaveBeenCalledWith('![a.png](/abs/a.png)\n\nhi')
  })

  it('pluralizes the missing-attachments toast', async () => {
    setup()
    attach([
      { id: 'gone1', title: 'x.png' },
      { id: 'gone2', title: 'y.png' }
    ])
    type('hi')
    await send()
    expect(mocks.toast).toHaveBeenCalledWith('2 images no longer available — skipping')
  })

  it('when every attachment is gone, sends just the text', async () => {
    setup()
    attach([{ id: 'gone', title: 'x.png' }])
    type('hi')
    await send()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('hi')
  })

  it('sends nothing when every attachment is gone and there is no text', async () => {
    setup()
    attach([{ id: 'gone', title: 'x.png' }])
    await send()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer.attachments).toEqual([])
  })
})

describe('useChatComposer queue', () => {
  it('queues instead of sending while a turn is in flight', async () => {
    setup({ inFlight: true })
    type('next one')
    await send()
    expect(mocks.queue.push).toHaveBeenCalledWith('next one', 'next one')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer.draft).toBe('')
  })

  it('queues when items are already queued, even with no turn in flight (FIFO)', async () => {
    mocks.queue.items = [
      {
        id: 'q1',
        tabId: 'tab-1',
        send: 'earlier',
        original: 'earlier',
        position: 0,
        createdAt: '2026-01-01'
      }
    ]
    setup({ inFlight: false })
    type('later')
    await send()
    expect(mocks.queue.push).toHaveBeenCalledWith('later', 'later')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a queued entry carries the expanded send text and the raw original', async () => {
    mocks.autocomplete.transformSubmit.mockReturnValue({ send: 'expanded template' })
    setup({ inFlight: true })
    type('/cmd arg')
    await send()
    expect(mocks.queue.push).toHaveBeenCalledWith('expanded template', '/cmd arg')
  })

  it('a drained queue entry bumps autocomplete usage with its original text', () => {
    setup()
    const onDrained = mocks.useChatQueue.mock.lastCall?.[1]
    expect(onDrained).toBeDefined()
    act(() => onDrained?.('/skill do it'))
    expect(mocks.autocomplete.bumpUsageFromMessage).toHaveBeenCalledWith('/skill do it')
  })
})

describe('useChatComposer handleStop', () => {
  it('clears the queue and aborts the turn', async () => {
    setup()
    await stop()
    expect(mocks.queue.clear).toHaveBeenCalled()
    expect(abortAndPop).toHaveBeenCalled()
  })

  it('a popped turn restores the raw text and attachments that were sent', async () => {
    abortAndPop.mockResolvedValue({ popped: true, text: 'main-side text' })
    setup()
    attach([IMG_A])
    type('fix this')
    await send()
    await stop()
    expect(composer.draft).toBe('fix this')
    expect(composer.attachments).toEqual([IMG_A])
  })

  it('focuses the textarea after restoring', async () => {
    abortAndPop.mockResolvedValue({ popped: true, text: 'main-side text' })
    setup()
    type('fix this')
    await send()
    textarea().blur()
    await stop()
    expect(document.activeElement).toBe(textarea())
  })

  it('a queued submit does not replace the in-flight snapshot', async () => {
    abortAndPop.mockResolvedValue({ popped: true, text: 'main-side text' })
    const { rerender } = setup()
    type('first')
    await send()
    rerender({ inFlight: true })
    type('second')
    await send()
    expect(mocks.queue.push).toHaveBeenCalledWith('second', 'second')
    await stop()
    expect(composer.draft).toBe('first')
  })

  it('without a local snapshot, restores the text the main side popped', async () => {
    abortAndPop.mockResolvedValue({ popped: true, text: 'main-side text' })
    setup()
    await stop()
    expect(composer.draft).toBe('main-side text')
  })

  it('does not overwrite a draft the user already started typing', async () => {
    abortAndPop.mockResolvedValue({ popped: true, text: 'main-side text' })
    setup()
    attach([IMG_A])
    type('first')
    await send()
    type('typing again')
    await stop()
    expect(composer.draft).toBe('typing again')
    expect(composer.attachments).toEqual([])
  })

  it('restores nothing when the turn was not popped', async () => {
    abortAndPop.mockResolvedValue({ popped: false, text: null })
    setup()
    type('first')
    await send()
    await stop()
    expect(composer.draft).toBe('')
  })
})

describe('useChatComposer onKeyDown', () => {
  it('Enter sends and prevents the newline', async () => {
    setup()
    type('hello')
    let notPrevented = true
    await act(async () => {
      notPrevented = fireEvent.keyDown(textarea(), { key: 'Enter' })
    })
    expect(notPrevented).toBe(false)
    expect(sendMessage).toHaveBeenCalledWith('hello')
  })

  it.each([
    ['Shift', { shiftKey: true }],
    ['Meta', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }]
  ])('%s+Enter does not send', async (_name, mods) => {
    setup()
    type('hello')
    let notPrevented = false
    await act(async () => {
      notPrevented = fireEvent.keyDown(textarea(), { key: 'Enter', ...mods })
    })
    expect(notPrevented).toBe(true)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a key the autocomplete consumes does not send', async () => {
    mocks.autocomplete.handleKeyDown.mockReturnValue(true)
    setup()
    type('/sk')
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: 'Enter' })
    })
    expect(mocks.autocomplete.handleKeyDown).toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('useChatComposer effects', () => {
  it('focuses the textarea when mounted active', () => {
    setup({ isActive: true })
    expect(document.activeElement).toBe(textarea())
  })

  it('focuses the textarea when the tab becomes active', () => {
    const { rerender } = setup({ isActive: false })
    expect(document.activeElement).not.toBe(textarea())
    rerender({ isActive: true })
    expect(document.activeElement).toBe(textarea())
  })

  it('scrolls to the bottom only when the draft goes from empty to non-empty', () => {
    setup()
    expect(scrollToBottom).not.toHaveBeenCalled()
    type('h')
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    type('he')
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    type('')
    type('x')
    expect(scrollToBottom).toHaveBeenCalledTimes(2)
  })
})
