// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ArtifactRef } from '@slayzone/editor/hooks'
import {
  type ChatAttachment,
  chatModelsView,
  type QueuedChatMessage,
  type StopResult,
  type UserContentBlock
} from '@slayzone/terminal-contracts'
import type { ChatActions, NavigateActions } from './autocomplete/types'

const mocks = vi.hoisted(() => {
  const queue = {
    items: [] as QueuedChatMessage[],
    push: vi.fn<
      (
        send: string,
        original: string,
        content?: UserContentBlock[]
      ) => Promise<{ id: string; delivered: Promise<void> }>
    >(),
    remove: vi.fn<(id: string) => Promise<void>>(),
    clear: vi.fn<() => Promise<void>>(),
    update:
      vi.fn<
        (
          id: string,
          send: string,
          original: string,
          content: UserContentBlock[]
        ) => Promise<boolean>
      >(),
    move: vi.fn<(id: string, toIndex: number) => Promise<void>>(),
    hold: vi.fn<(id: string) => Promise<boolean>>(),
    release: vi.fn<(id: string) => Promise<void>>(),
    steer: vi.fn<(id: string) => Promise<{ ok: true } | { ok: false; reason: string }>>()
  }
  return {
    toast: vi.fn(),
    persistence: {
      loaded: true,
      saved: null as null | { text: string; attachments: ChatAttachment[] },
      calls: [] as Array<{ text: string; paused: boolean; enabled: boolean }>
    },
    queue,
    history: {
      entries: [] as string[],
      record: vi.fn<(text: string, attachments?: ChatAttachment[]) => void>(),
      attachmentsOf: vi.fn<(text: string) => ChatAttachment[] | null>()
    },
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
// The saved draft (react-query + server): a controllable stand-in.
vi.mock('./composer-state/useChatDraftPersistence', () => ({
  useChatDraftPersistence: (o: { text: string; paused: boolean; enabled: boolean }) => {
    mocks.persistence.calls.push({ text: o.text, paused: o.paused, enabled: o.enabled })
    return { loaded: mocks.persistence.loaded, saved: mocks.persistence.saved }
  }
}))
// Prompt history reads stored prompts through react-query: same treatment.
vi.mock('./usePromptHistory', () => ({ usePromptHistory: () => mocks.history }))
// The autocomplete is a seam here: the composer only consumes handleKeyDown,
// transformSubmit and bumpUsageFromMessage. The sources keep importing the real helpers.
vi.mock('./autocomplete/useAutocomplete', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAutocomplete: () => mocks.autocomplete
}))

import { useChatComposer, type UseChatComposerOpts } from './useChatComposer'
import { buildPromptHistory, recordedAttachments } from './prompt-history'

const sendMessage = vi.fn<(input: string | UserContentBlock[]) => Promise<void>>()
const abortAndPop = vi.fn<() => Promise<StopResult>>()
/** What Stop returns for a popped message (the whole message, as the transport sends it). */
const popped = (text: string): StopResult => ({
  popped: true,
  text,
  id: 'popped-id',
  content: [{ type: 'text', text }]
})
/** Stop's result for the message the composer last sent itself (as the session sends it). */
const poppedSent = (): StopResult => {
  const input = sendMessage.mock.lastCall?.[0]
  if (input === undefined) throw new Error('nothing was sent')
  const content: UserContentBlock[] =
    typeof input === 'string' ? [{ type: 'text', text: input }] : input
  return {
    popped: true,
    text: content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n'),
    id: 'sent-id',
    content
  }
}
const getArtifactFilePath = vi.fn<(id: string) => Promise<string | null>>()
const scrollToBottom = vi.fn<() => void>()
const handleEffortChange = vi.fn<(next: string) => Promise<void>>()
const handleModelChange = vi.fn<(next: string) => Promise<void>>()

const img = (artifactId: string, name = `${artifactId}.png`): ChatAttachment => ({
  artifactId,
  name,
  kind: 'image',
  mediaType: 'image/png',
  size: 10
})
const IMG_A = img('a')
const IMG_B = img('b')
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
  models: chatModelsView('claude-chat', undefined),
  chatModel: 'opus',
  handleModelChange,
  cliCommands: null,
  turnId: 0,
  ...over
})

function setup(over: Partial<UseChatComposerOpts> = {}) {
  const view = render(<Harness {...opts(over)} />)
  return {
    rerender: (next: Partial<UseChatComposerOpts>) => view.rerender(<Harness {...opts(next)} />)
  }
}

const type = (text: string) => act(() => composer.setDraft(text))
const attach = (files: ChatAttachment[]) => act(() => composer.setAttachments(files))
const send = () => act(() => composer.handleSend())
const stop = () => act(() => composer.handleStop())
const textarea = () => screen.getByLabelText('Message') as HTMLTextAreaElement

beforeEach(() => {
  mocks.persistence.loaded = true
  mocks.persistence.saved = null
  mocks.persistence.calls = []
  mocks.toast.mockReset()
  mocks.queue.items = []
  mocks.queue.push.mockReset().mockResolvedValue({ id: 'queued-1', delivered: Promise.resolve() })
  mocks.queue.steer.mockReset().mockResolvedValue({ ok: true })
  mocks.queue.remove.mockReset().mockResolvedValue(undefined)
  mocks.queue.clear.mockReset().mockResolvedValue(undefined)
  mocks.useChatQueue.mockClear()
  mocks.autocomplete.handleKeyDown.mockReset().mockReturnValue(false)
  mocks.autocomplete.transformSubmit.mockReset().mockReturnValue(null)
  mocks.autocomplete.bumpUsageFromMessage.mockReset().mockResolvedValue(undefined)
  sendMessage.mockReset().mockResolvedValue(undefined)
  abortAndPop.mockReset().mockResolvedValue({ popped: false, text: null, id: null, content: null })
  getArtifactFilePath.mockReset().mockImplementation((id) => Promise.resolve(PATHS[id] ?? null))
  scrollToBottom.mockReset()
  handleEffortChange.mockReset().mockResolvedValue(undefined)
  handleModelChange.mockReset().mockResolvedValue(undefined)
  mocks.history.entries = []
  mocks.history.record.mockReset()
  mocks.history.attachmentsOf.mockReset().mockReturnValue(null)
})

afterEach(cleanup)

describe('useChatComposer clearDraft', () => {
  it('clears text and attachments without sending or changing the queue', () => {
    setup()
    type('unfinished message')
    attach([IMG_A])
    act(() => composer.clearDraft())
    expect(composer.draft).toBe('')
    expect(composer.attachments).toEqual([])
    expect(mocks.persistence.calls.at(-1)?.text).toBe('')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(mocks.queue.clear).not.toHaveBeenCalled()
  })
})

describe('useChatComposer discardDraft (Esc Esc: clears, recoverably)', () => {
  /** The prompt history as `usePromptHistory` keeps it: this composer's records, newest first. */
  const liveHistory = () => {
    const records: { text: string; attachments: ChatAttachment[] }[] = []
    mocks.history.record.mockImplementation((text, attachments = []) => {
      records.unshift({ text, attachments })
      mocks.history.entries = buildPromptHistory(
        records.map((r) => r.text),
        []
      )
    })
    mocks.history.attachmentsOf.mockImplementation((text) => recordedAttachments(records, text))
  }
  const undo = () => {
    const options = mocks.toast.mock.lastCall?.[1] as
      | { action?: { label: string; onClick: () => void } }
      | undefined
    expect(options?.action?.label).toBe('Undo')
    act(() => options?.action?.onClick())
  }
  const key = (k: string) => fireEvent.keyDown(textarea(), { key: k })

  it('clears text and files without sending or changing the queue', () => {
    setup()
    type('unfinished message')
    attach([IMG_A])
    act(() => composer.discardDraft())
    expect(composer.draft).toBe('')
    expect(composer.attachments).toEqual([])
    expect(sendMessage).not.toHaveBeenCalled()
    expect(mocks.queue.clear).not.toHaveBeenCalled()
  })

  it('Undo brings the text and files back exactly', () => {
    setup()
    type('unfinished message\n  with a second line ')
    attach([IMG_A, IMG_B])
    act(() => composer.discardDraft())
    undo()
    expect(composer.draft).toBe('unfinished message\n  with a second line ')
    expect(composer.attachments).toEqual([IMG_A, IMG_B])
    expect(mocks.persistence.calls.at(-1)?.text).toBe('unfinished message\n  with a second line ')
  })

  it('Undo after writing again keeps what was written since', () => {
    setup()
    type('cleared')
    attach([IMG_A])
    act(() => composer.discardDraft())
    type('new')
    attach([IMG_B])
    undo()
    expect(composer.draft).toBe('new\n\ncleared')
    expect(composer.attachments).toEqual([IMG_B, IMG_A])
  })

  it('files alone can be undone too', () => {
    setup()
    attach([IMG_A])
    act(() => composer.discardDraft())
    expect(mocks.history.record).not.toHaveBeenCalled()
    undo()
    expect(composer.draft).toBe('')
    expect(composer.attachments).toEqual([IMG_A])
  })

  it('a whitespace-only draft is cleared with no Undo and no history entry', () => {
    setup()
    type('  \n ')
    act(() => composer.discardDraft())
    expect(composer.draft).toBe('')
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.history.record).not.toHaveBeenCalled()
  })

  it('goes into the prompt history with its files: ↑ brings both back, ↓ the empty composer', () => {
    liveHistory()
    setup()
    type('unfinished')
    attach([IMG_A])
    act(() => composer.discardDraft())
    expect(mocks.history.record).toHaveBeenCalledWith('unfinished', [IMG_A])
    key('ArrowUp')
    expect(composer.draft).toBe('unfinished')
    expect(composer.attachments).toEqual([IMG_A])
    key('ArrowDown')
    expect(composer.draft).toBe('')
    expect(composer.attachments).toEqual([])
  })

  it('walking past it to a plain prompt brings back the files the composer held', () => {
    liveHistory()
    setup()
    act(() => mocks.history.record('plain'))
    type('with files')
    attach([IMG_A])
    act(() => composer.discardDraft())
    attach([IMG_B])
    key('ArrowUp')
    expect(composer.draft).toBe('with files')
    expect(composer.attachments).toEqual([IMG_A])
    key('ArrowUp')
    expect(composer.draft).toBe('plain')
    expect(composer.attachments).toEqual([IMG_B])
    key('ArrowDown')
    expect(composer.attachments).toEqual([IMG_A])
    key('ArrowDown')
    expect(composer.draft).toBe('')
    expect(composer.attachments).toEqual([IMG_B])
  })

  it('plain prompts recalled with ↑ leave the composer files alone', () => {
    mocks.history.entries = ['older']
    setup()
    attach([IMG_B])
    key('ArrowUp')
    expect(composer.draft).toBe('older')
    expect(composer.attachments).toEqual([IMG_B])
    key('ArrowDown')
    expect(composer.draft).toBe('')
    expect(composer.attachments).toEqual([IMG_B])
  })

  it('a Ctrl+R pick of it brings its files back too', () => {
    liveHistory()
    setup()
    type('unfinished')
    attach([IMG_A])
    act(() => composer.discardDraft())
    act(() => composer.historySearch.pick('unfinished'))
    expect(composer.draft).toBe('unfinished')
    expect(composer.attachments).toEqual([IMG_A])
  })

  it('a send clears the composer with no Undo (clearDraft stays silent)', async () => {
    setup({ inFlight: true })
    type('queued')
    await send()
    expect(composer.draft).toBe('')
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})

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

describe('useChatComposer /btw side question', () => {
  it('asks the side question — mid-turn too — clears the text, keeps attachments, sends and queues nothing', async () => {
    const onSideQuestion = vi.fn<(question: string) => void>()
    setup({ onSideQuestion, inFlight: true })
    attach([IMG_A])
    type('/btw  why that file?\nand this one ')
    await send()
    expect(onSideQuestion).toHaveBeenCalledWith('why that file?\nand this one')
    expect(composer.draft).toBe('')
    expect(composer.attachments).toEqual([IMG_A])
    expect(sendMessage).not.toHaveBeenCalled()
    expect(mocks.queue.push).not.toHaveBeenCalled()
  })

  it('a bare /btw asks for the question and sends nothing', async () => {
    const onSideQuestion = vi.fn<(question: string) => void>()
    setup({ onSideQuestion })
    type('/btw ')
    await send()
    expect(onSideQuestion).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith('Type a question after /btw')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer.draft).toBe('/btw ')
  })

  it('without side questions (no handler) /btw is ordinary text', async () => {
    setup()
    type('/btw hi')
    await send()
    expect(sendMessage).toHaveBeenCalledWith('/btw hi')
  })

  it('/btwx is not /btw', async () => {
    const onSideQuestion = vi.fn<(question: string) => void>()
    setup({ onSideQuestion })
    type('/btwx hi')
    await send()
    expect(onSideQuestion).not.toHaveBeenCalled()
  })
})

describe('useChatComposer /effort on Codex', () => {
  const codex = chatModelsView('codex-chat', [
    {
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      supportsEffort: true,
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'ultra', label: 'Ultra' }
      ]
    },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', supportsEffort: false }
  ])

  it("takes the model's own level", async () => {
    setup({ mode: 'codex-chat', models: codex, chatModel: 'gpt-6-luna' })
    type('/effort ultra')
    await send()
    expect(handleEffortChange).toHaveBeenCalledWith('ultra')
  })

  it("refuses on a model that lists no levels — Claude's are not accepted", async () => {
    setup({ mode: 'codex-chat', models: codex, chatModel: 'gpt-6.1-sol' })
    type('/effort high')
    await send()
    expect(mocks.toast).toHaveBeenCalledWith('GPT-6.1 Sol has no effort levels.')
    expect(handleEffortChange).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer.draft).toBe('/effort high')
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

  it('Codex sends image references and clean text, without resolving paths', async () => {
    setup({ mode: 'codex-chat' })
    attach([IMG_A, IMG_B])
    type('look at these')
    await send()
    expect(sendMessage).toHaveBeenCalledWith([
      { type: 'attachment', attachment: IMG_A },
      { type: 'attachment', attachment: IMG_B },
      { type: 'text', text: 'look at these' }
    ])
    expect(composer.attachments).toEqual([])
  })

  it('Codex sends image-only messages without dropping missing artifact references', async () => {
    setup({ mode: 'codex-chat' })
    const missing = img('gone', 'gone.png')
    attach([missing])
    await send()
    expect(sendMessage).toHaveBeenCalledWith([{ type: 'attachment', attachment: missing }])
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})

describe('useChatComposer queue', () => {
  it('a stale send handler cannot submit the cleared draft twice after queue acknowledgement', async () => {
    setup({ inFlight: true })
    type('once')
    const sendSameHandler = composer.handleSend
    await act(async () => {
      await sendSameHandler()
      await sendSameHandler()
    })
    expect(mocks.queue.push).toHaveBeenCalledTimes(1)
    expect(composer.draft).toBe('')
  })

  it('queue acknowledgement preserves text and files edited while it was pending', async () => {
    let finish!: () => void
    mocks.queue.push.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ id: 'queued-1', delivered: Promise.resolve() })
        })
    )
    setup({ inFlight: true })
    type('queued')
    attach([IMG_A])
    let pending!: Promise<void>
    await act(async () => {
      pending = composer.handleSend()
    })
    type('newer')
    attach([IMG_B])
    await act(async () => {
      finish()
      await pending
    })
    expect(composer.draft).toBe('newer')
    expect(composer.attachments).toEqual([IMG_B])
  })
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
    setup()
    attach([IMG_A])
    type('fix this')
    await send()
    abortAndPop.mockResolvedValue(poppedSent())
    await stop()
    expect(composer.draft).toBe('fix this')
    expect(composer.attachments).toEqual([IMG_A])
  })

  it('the message sent from here comes back as typed, not as its expanded send text', async () => {
    mocks.autocomplete.transformSubmit.mockReturnValue({ send: 'expanded template' })
    setup()
    type('/cmd arg')
    await send()
    abortAndPop.mockResolvedValue(poppedSent())
    await stop()
    expect(composer.draft).toBe('/cmd arg')
  })

  it('paths mode: the message sent from here comes back as clean text + chips, not inline image refs', async () => {
    setup({ mode: 'terminal' })
    attach([IMG_A])
    type('fix this')
    await send()
    expect(sendMessage).toHaveBeenCalledWith('![a.png](/abs/a.png)\n\nfix this')
    abortAndPop.mockResolvedValue(poppedSent())
    await stop()
    expect(composer.draft).toBe('fix this')
    expect(composer.attachments).toEqual([IMG_A])
  })

  it('a queued message the hub sent next comes back — not the earlier one sent from here', async () => {
    const { rerender } = setup()
    attach([IMG_A])
    type('A')
    await send()
    rerender({ inFlight: true })
    attach([IMG_B])
    type('B')
    await send()
    // A finished; the hub sent B; Stop before the CLI read it withdraws B.
    abortAndPop.mockResolvedValue({
      popped: true,
      text: 'B',
      id: 'b-id',
      content: [
        { type: 'attachment', attachment: IMG_B },
        { type: 'text', text: 'B' }
      ]
    })
    await stop()
    expect(composer.draft).toBe('B')
    expect(composer.attachments).toEqual([IMG_B])
  })

  it('a message sent elsewhere (another device, a retry, a timeline button) comes back as popped', async () => {
    setup()
    type('sent from here')
    await send()
    abortAndPop.mockResolvedValue(popped('sent elsewhere'))
    await stop()
    expect(composer.draft).toBe('sent elsewhere')
  })

  it('the local snapshot is spent once the stop popped something else', async () => {
    setup()
    type('sent from here')
    await send()
    abortAndPop.mockResolvedValue(popped('sent elsewhere'))
    await stop()
    act(() => composer.clearDraft())
    abortAndPop.mockResolvedValue(popped('sent from here'))
    await stop()
    expect(composer.draft).toBe('sent from here')
    expect(composer.attachments).toEqual([])
  })

  it('files only in the composer: the popped message comes back and its files join them', async () => {
    abortAndPop.mockResolvedValue({
      popped: true,
      text: 'B',
      id: 'b-id',
      content: [
        { type: 'attachment', attachment: IMG_B },
        { type: 'text', text: 'B' }
      ]
    })
    setup()
    attach([IMG_A])
    await stop()
    expect(composer.draft).toBe('B')
    expect(composer.attachments).toEqual([IMG_A, IMG_B])
  })

  it('files only in the composer: the restored snapshot files join them too', async () => {
    setup()
    attach([IMG_B])
    type('fix this')
    await send()
    abortAndPop.mockResolvedValue(poppedSent())
    attach([IMG_A])
    await stop()
    expect(composer.draft).toBe('fix this')
    expect(composer.attachments).toEqual([IMG_A, IMG_B])
  })

  it('focuses the textarea after restoring', async () => {
    abortAndPop.mockResolvedValue(popped('main-side text'))
    setup()
    type('fix this')
    await send()
    textarea().blur()
    await stop()
    expect(document.activeElement).toBe(textarea())
  })

  it('a queued submit does not replace the in-flight snapshot', async () => {
    mocks.autocomplete.transformSubmit.mockReturnValue({ send: 'expanded template' })
    const { rerender } = setup()
    type('/cmd first')
    await send()
    rerender({ inFlight: true })
    abortAndPop.mockResolvedValue(poppedSent())
    mocks.autocomplete.transformSubmit.mockReturnValue(null)
    type('second')
    await send()
    expect(mocks.queue.push).toHaveBeenCalledWith('second', 'second')
    await stop()
    expect(composer.draft).toBe('/cmd first')
  })

  it('without a local snapshot, restores the text the main side popped', async () => {
    abortAndPop.mockResolvedValue(popped('main-side text'))
    setup()
    await stop()
    expect(composer.draft).toBe('main-side text')
  })

  it('without a local snapshot (remounted since), restores the files of the popped message from its content', async () => {
    abortAndPop.mockResolvedValue({
      popped: true,
      text: 'main-side text',
      id: 'popped-id',
      content: [
        { type: 'attachment', attachment: IMG_A },
        { type: 'text', text: 'main-side text' }
      ]
    })
    setup()
    await stop()
    expect(composer.draft).toBe('main-side text')
    expect(composer.attachments).toEqual([IMG_A])
  })

  it('does not overwrite a draft the user already started typing', async () => {
    abortAndPop.mockResolvedValue(popped('main-side text'))
    setup()
    attach([IMG_A])
    type('first')
    await send()
    type('typing again')
    await stop()
    expect(composer.draft).toBe('typing again')
    expect(composer.attachments).toEqual([])
  })

  // TUI parity: Stop shows at once, not after the round trip to the agent.
  const deferredStop = () => {
    let settle!: { resolve: (r: StopResult) => void; reject: (e: Error) => void }
    abortAndPop.mockImplementation(
      () => new Promise<StopResult>((resolve, reject) => (settle = { resolve, reject }))
    )
    return () => settle
  }
  const notPopped: StopResult = { popped: false, text: null, id: null, content: null }

  it('reads as stopping from the press until the turn closes', async () => {
    const settle = deferredStop()
    const { rerender } = setup({ inFlight: true, turnId: 3 })
    expect(composer.stopping).toBe(false)
    act(() => void composer.handleStop())
    expect(composer.stopping).toBe(true)
    await act(async () => settle().resolve(notPopped))
    // The request is done; the turn's end (an event) has not arrived yet.
    expect(composer.stopping).toBe(true)
    rerender({ inFlight: false, turnId: 4 })
    expect(composer.stopping).toBe(false)
    // The next turn is not stopping.
    rerender({ inFlight: true, turnId: 4 })
    expect(composer.stopping).toBe(false)
  })

  it('presses while the stop request runs send nothing more; one after it, with the turn still open, asks again', async () => {
    const settle = deferredStop()
    setup({ inFlight: true, turnId: 3 })
    act(() => void composer.handleStop())
    act(() => void composer.handleStop())
    act(() => void composer.handleStop())
    expect(abortAndPop).toHaveBeenCalledTimes(1)
    await act(async () => settle().resolve(notPopped))
    act(() => void composer.handleStop())
    expect(abortAndPop).toHaveBeenCalledTimes(2)
  })

  it('a failed stop no longer reads as stopping', async () => {
    const settle = deferredStop()
    setup({ inFlight: true, turnId: 3 })
    let done!: Promise<void>
    act(() => {
      done = composer.handleStop()
    })
    await act(async () => {
      settle().reject(new Error('hub gone'))
      await done.catch(() => undefined)
    })
    expect(composer.stopping).toBe(false)
  })

  it('restores nothing when the turn was not popped', async () => {
    abortAndPop.mockResolvedValue({ popped: false, text: null, id: null, content: null })
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

  const sendNowKey = async (
    mods: { metaKey?: boolean; ctrlKey?: boolean } = { metaKey: true }
  ): Promise<boolean> => {
    let notPrevented = true
    await act(async () => {
      notPrevented = fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true, ...mods })
    })
    return notPrevented
  }

  it.each([
    ['Cmd', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }]
  ])(
    '%s+Shift+Enter mid-turn sends straight into the running turn (queued, then steered)',
    async (_name, mods) => {
      setup({ inFlight: true, steerAvailable: true })
      type('look at the tests too')
      expect(await sendNowKey(mods)).toBe(false)
      expect(mocks.queue.push).toHaveBeenCalledWith(
        'look at the tests too',
        'look at the tests too'
      )
      await vi.waitFor(() => expect(mocks.queue.steer).toHaveBeenCalledWith('queued-1'))
      expect(sendMessage).not.toHaveBeenCalled()
      expect(composer.draft).toBe('')
      expect(mocks.toast).not.toHaveBeenCalled()
    }
  )

  it('Cmd+Shift+Enter jumps a queue that already waits', async () => {
    mocks.queue.items = [{ id: 'q1', send: 'first', original: 'first' } as QueuedChatMessage]
    setup({ inFlight: true, steerAvailable: true })
    type('urgent')
    await sendNowKey()
    await vi.waitFor(() => expect(mocks.queue.steer).toHaveBeenCalledWith('queued-1'))
  })

  it('Cmd+Shift+Enter with no turn running sends like Enter', async () => {
    setup({ steerAvailable: false })
    type('hello')
    expect(await sendNowKey()).toBe(false)
    expect(sendMessage).toHaveBeenCalledWith('hello')
    expect(mocks.queue.steer).not.toHaveBeenCalled()
  })

  it('Cmd+Shift+Enter steers only once the hub has the message', async () => {
    let confirm!: () => void
    const delivered = new Promise<void>((resolve) => {
      confirm = resolve
    })
    mocks.queue.push.mockResolvedValue({ id: 'queued-1', delivered })
    setup({ inFlight: true, steerAvailable: true })
    type('later')
    await sendNowKey()
    expect(composer.draft).toBe('')
    expect(mocks.queue.steer).not.toHaveBeenCalled()
    await act(async () => confirm())
    await vi.waitFor(() => expect(mocks.queue.steer).toHaveBeenCalledWith('queued-1'))
  })

  it('Cmd+Shift+Enter: a delivery that fails is not steered (its row shows why)', async () => {
    const delivered = Promise.reject(new Error('Computer offline'))
    delivered.catch(() => undefined)
    mocks.queue.push.mockResolvedValue({ id: 'queued-1', delivered })
    setup({ inFlight: true, steerAvailable: true })
    type('later')
    await sendNowKey()
    expect(mocks.queue.steer).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('Cmd+Shift+Enter: a refused steer says why; the message stays queued', async () => {
    mocks.queue.steer.mockResolvedValue({ ok: false, reason: 'no active turn to steer' })
    setup({ inFlight: true, steerAvailable: true })
    type('later')
    await sendNowKey()
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith('Could not send it now: no active turn to steer')
    )
    expect(mocks.queue.remove).not.toHaveBeenCalled()
  })

  it('Cmd+Shift+Enter while the agent waits for an answer queues it and says why', async () => {
    setup({ inFlight: true, steerAvailable: false })
    type('later')
    await sendNowKey()
    expect(mocks.queue.push).toHaveBeenCalledWith('later', 'later')
    expect(mocks.queue.steer).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith(
      "Queued: the agent is waiting for your answer, so it can't take a message now."
    )
  })

  it('Cmd+Shift+Enter where the agent takes no messages mid-turn queues it and says why', async () => {
    setup({ mode: 'terminal', inFlight: true, steerAvailable: true })
    type('later')
    await sendNowKey()
    expect(mocks.queue.push).toHaveBeenCalledWith('later', 'later')
    expect(mocks.queue.steer).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith("Queued: this agent can't take a message mid-turn.")
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
})

describe('useChatComposer attachments as content blocks (Claude)', () => {
  const block = (a: ChatAttachment): UserContentBlock => ({ type: 'attachment', attachment: a })

  it('sends the files FIRST and the typed text LAST, so a /command stays a command', async () => {
    setup()
    attach([IMG_A, IMG_B])
    type('/x MANGO 3')
    await send()
    expect(sendMessage).toHaveBeenCalledWith([
      block(IMG_A),
      block(IMG_B),
      { type: 'text', text: '/x MANGO 3' }
    ])
    expect(getArtifactFilePath).not.toHaveBeenCalled()
    expect(composer.attachments).toEqual([])
  })

  it('files alone: no text block', async () => {
    setup()
    attach([IMG_A])
    await send()
    expect(sendMessage).toHaveBeenCalledWith([block(IMG_A)])
  })

  it('text alone still goes as plain text', async () => {
    setup()
    type('hello')
    await send()
    expect(sendMessage).toHaveBeenCalledWith('hello')
  })

  it('clears the draft and files BEFORE anything is awaited', async () => {
    let resolveSend = () => {}
    sendMessage.mockReturnValue(new Promise<void>((r) => (resolveSend = r)))
    setup()
    attach([IMG_A])
    type('look')
    let pending: Promise<void> = Promise.resolve()
    // Synchronous act: flushes what handleSend did before its first await.
    act(() => {
      pending = composer.handleSend()
    })
    expect(sendMessage).toHaveBeenCalled()
    expect(composer.draft).toBe('')
    expect(composer.attachments).toEqual([])
    await act(async () => {
      resolveSend()
      await pending
    })
  })

  it('a queued message carries its files', async () => {
    setup({ inFlight: true })
    attach([IMG_A])
    type('next')
    await send()
    expect(mocks.queue.push).toHaveBeenCalledWith('next', 'next', [
      block(IMG_A),
      { type: 'text', text: 'next' }
    ])
  })

  it('over the conversation budget: nothing is sent, the draft stays, the reason is shown', async () => {
    setup({ attachmentsUsedBytes: 24 * 1024 * 1024 })
    attach([{ ...IMG_A, size: 3 * 1024 * 1024 }])
    type('one more')
    await send()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/\/compact/))
    expect(composer.draft).toBe('one more')
    expect(composer.attachments).toHaveLength(1)
  })

  it('a popped turn restores its files too', async () => {
    setup()
    attach([IMG_A])
    type('fix this')
    await send()
    abortAndPop.mockResolvedValue(poppedSent())
    await stop()
    expect(composer.draft).toBe('fix this')
    expect(composer.attachments).toEqual([IMG_A])
  })
})

describe('useChatComposer argument hint (ghost text after `/name `)', () => {
  const list = {
    slashCommands: ['compact', 'x'],
    terminalSlashCommands: [],
    skills: [],
    cliVersion: '2.1.312',
    details: {
      compact: { description: 'Free up context', argumentHint: '<optional instructions>' },
      x: { description: 'Spike x (project)', argumentHint: '<fruit> <count>' }
    }
  }
  const at = (text: string) =>
    act(() => {
      composer.setDraft(text)
      composer.setCursorPos(text.length)
    })

  it('shows the hint right after a parked command, and only then', () => {
    setup({ cliCommands: list })
    at('/x ')
    expect(composer.argumentHint).toBe('<fruit> <count>')
    at('/x MANGO')
    expect(composer.argumentHint).toBeNull()
    at('/compact')
    expect(composer.argumentHint).toBeNull()
    at('/nope ')
    expect(composer.argumentHint).toBeNull()
  })

  it('no hint for providers without CLI commands', () => {
    setup({ mode: 'codex-chat', cliCommands: list })
    at('/x ')
    expect(composer.argumentHint).toBeNull()
  })
})

describe('useChatComposer draft restore (per tab, survives remount + reload)', () => {
  it.each(['claude-chat', 'codex-chat'])('%s typing leaves the timeline in place', (mode) => {
    setup({ mode })
    for (const text of ['h', 'hello', 'hello\nworld', '', 'new draft']) {
      fireEvent.change(textarea(), { target: { value: text } })
      expect(scrollToBottom).not.toHaveBeenCalled()
    }
  })

  it.each(['claude-chat', 'codex-chat'])(
    '%s history arrows do not snap the timeline down',
    (mode) => {
      mocks.history.entries = ['newer prompt', 'older prompt']
      setup({ mode })
      for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowUp']) {
        fireEvent.keyDown(textarea(), { key })
        expect(scrollToBottom).not.toHaveBeenCalled()
      }
      fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
      expect(composer.draft).toBe('')
      type('new draft')
      expect(scrollToBottom).not.toHaveBeenCalled()
    }
  )

  it.each(['claude-chat', 'codex-chat'])('%s recalls prompts and restores the draft', (mode) => {
    mocks.history.entries = ['newer prompt', 'older prompt']
    setup({ mode })
    type('unfinished draft')
    textarea().setSelectionRange(0, 0)
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
    expect(composer.draft).toBe('newer prompt')
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
    expect(composer.draft).toBe('older prompt')
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
    expect(composer.draft).toBe('newer prompt')
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
    expect(composer.draft).toBe('unfinished draft')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('restores the saved draft (text + files) once, without snapping the timeline down', async () => {
    mocks.persistence.saved = { text: 'half a thought', attachments: [IMG_A] }
    setup()
    expect(composer.draft).toBe('half a thought')
    expect(composer.attachments).toEqual([IMG_A])
    expect(scrollToBottom).not.toHaveBeenCalled()
  })

  it('waits for the saved draft, and a draft typed meanwhile wins', () => {
    mocks.persistence.loaded = false
    mocks.persistence.saved = null
    const { rerender } = setup()
    type('typed first')
    mocks.persistence.loaded = true
    mocks.persistence.saved = { text: 'saved earlier', attachments: [] }
    rerender({})
    expect(composer.draft).toBe('typed first')
  })

  it('Codex restores its saved draft', () => {
    mocks.persistence.saved = { text: 'x', attachments: [] }
    setup({ mode: 'codex-chat' })
    expect(composer.draft).toBe('x')
    expect(mocks.persistence.calls.at(-1)?.enabled).toBe(true)
  })

  it('browsing prompt history pauses saving', () => {
    mocks.history.entries = ['older prompt']
    setup()
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
    expect(composer.draft).toBe('older prompt')
    expect(mocks.persistence.calls.at(-1)).toMatchObject({ text: 'older prompt', paused: true })
  })
})

describe('useChatComposer queue edit + send-now seam', () => {
  it('an edit is saved as files first, text last', async () => {
    mocks.queue.update.mockResolvedValue(true)
    setup()
    await act(() => composer.queueApi.onSave('q1', 'better', [IMG_A]))
    expect(mocks.queue.update).toHaveBeenCalledWith('q1', 'better', 'better', [
      { type: 'attachment', attachment: IMG_A },
      { type: 'text', text: 'better' }
    ])
  })

  it('an edit whose message went out anyway lands in the composer (after what is there)', () => {
    setup()
    type('already typing')
    act(() => composer.queueApi.onSaveGone('my edit', [IMG_A]))
    expect(composer.draft).toBe('already typing\n\nmy edit')
    expect(composer.attachments).toEqual([IMG_A])
  })

  it('"Send now" exists only when a turn can be interrupted without dropping the queue', async () => {
    setup()
    expect(composer.queueApi.onSendNow).toBeUndefined()
    cleanup()
    const interruptTurn = vi.fn(() => Promise.resolve())
    mocks.queue.move.mockResolvedValue(undefined)
    setup({ interruptTurn })
    await act(async () => composer.queueApi.onSendNow?.('q2'))
    expect(mocks.queue.move).toHaveBeenCalledWith('q2', 0)
    expect(interruptTurn).toHaveBeenCalled()
  })

  it('"Send now" only while the agent can take one (Claude / Codex), refusals toast why', async () => {
    setup()
    expect(composer.queueApi.onSteer).toBeUndefined()
    expect(composer.queueApi.withdrawSteered).toBe(true)
    cleanup()
    setup({ mode: 'terminal', steerAvailable: true })
    expect(composer.queueApi.onSteer).toBeUndefined()
    cleanup()
    mocks.queue.steer.mockResolvedValue({ ok: true })
    setup({ steerAvailable: true })
    await act(async () => composer.queueApi.onSteer?.('q2'))
    expect(mocks.queue.steer).toHaveBeenCalledWith('q2')
    expect(mocks.toast).not.toHaveBeenCalled()
    mocks.queue.steer.mockResolvedValue({ ok: false, reason: 'no active turn to steer' })
    await act(async () => composer.queueApi.onSteer?.('q2'))
    expect(mocks.toast).toHaveBeenCalledWith('Could not send it now: no active turn to steer')
    mocks.queue.steer.mockRejectedValue(new Error('Chat operation unavailable'))
    await act(async () => composer.queueApi.onSteer?.('q2'))
    expect(mocks.toast).toHaveBeenLastCalledWith(
      'Could not send it now: Chat operation unavailable'
    )
  })
})
