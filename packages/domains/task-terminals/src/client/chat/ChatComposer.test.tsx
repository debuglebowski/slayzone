// @vitest-environment jsdom
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { appearanceDefaults } from '@slayzone/ui'
import type { ChatAttachment, QueuedChatMessage } from '@slayzone/terminal-contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mutate = vi.fn()

vi.mock('../trpc', () => ({
  useTRPC: () => ({ settings: { set: { mutationOptions: () => ({}) } } })
}))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMutation: () => ({ mutate })
}))
// Thumbnails resolve the artifact's file path through the app's uploader.
vi.mock('@slayzone/editor/hooks', () => ({
  useArtifactUpload: () => ({ uploadFiles: vi.fn(), getFilePath: async () => null })
}))

import { ChatComposer, type ChatComposerProps } from './ChatComposer'
import type { AutocompleteSource } from './autocomplete/types'

// jsdom ships no ResizeObserver; Radix popper content (Display popover, pill menus)
// only constructs/observes/disconnects one.
globalThis.ResizeObserver = class {
  observe() {
    // Never fires: no layout engine in jsdom.
  }
  unobserve() {
    // Nothing was observed.
  }
  disconnect() {
    // Nothing was observed.
  }
}

const att = (
  artifactId: string,
  name: string,
  over: Partial<ChatAttachment> = {}
): ChatAttachment => ({
  artifactId,
  name,
  kind: 'image',
  mediaType: 'image/png',
  size: 2048,
  ...over
})
const IMG = att('a', 'shot.png')
const queued = (id: string, send: string): QueuedChatMessage => ({
  id,
  tabId: 'tab-1',
  send,
  original: send,
  position: 0,
  createdAt: '2026-01-01'
})

let props: ChatComposerProps

function makeProps(over: Partial<ChatComposerProps> = {}): ChatComposerProps {
  return {
    appearance: appearanceDefaults,
    finalOnly: false,
    inFlight: false,
    mode: 'claude-chat',
    queuedMessages: [],
    removeQueue: vi.fn(() => Promise.resolve()),
    queueApi: {
      editable: true,
      onMove: vi.fn(() => Promise.resolve()),
      onHold: vi.fn(() => Promise.resolve(true)),
      onRelease: vi.fn(() => Promise.resolve()),
      onSave: vi.fn(() => Promise.resolve(true)),
      onSaveGone: vi.fn()
    },
    attachments: [],
    setAttachments: vi.fn(),
    attachmentsApi: {
      pending: [],
      isDragging: false,
      addFiles: vi.fn(() => Promise.resolve()),
      onDragEnter: vi.fn(),
      onDragOver: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
      onPaste: vi.fn()
    },
    autocomplete: {
      show: false,
      active: null,
      selectedIndex: 0,
      setSelectedIndex: vi.fn(),
      accept: vi.fn(),
      close: vi.fn(),
      handleKeyDown: vi.fn(() => false),
      transformSubmit: vi.fn(() => null),
      bumpUsageFromMessage: vi.fn(() => Promise.resolve())
    },
    textareaRef: createRef<HTMLTextAreaElement>(),
    draft: '',
    setDraft: vi.fn(),
    setCursorPos: vi.fn(),
    onKeyDown: vi.fn(),
    handleSend: vi.fn(),
    handleStop: vi.fn(),
    historySearch: { open: false, entries: [], pick: vi.fn(), close: vi.fn() },
    usage: null,
    displaySessionEnded: false,
    handleRestart: vi.fn(),
    restarting: false,
    handleReset: vi.fn(),
    resetting: false,
    chatMode: 'auto-accept',
    handleModeChange: vi.fn(() => Promise.resolve()),
    autoCapability: { eligible: false, optedIn: false },
    chatModel: 'opus',
    handleModelChange: vi.fn(() => Promise.resolve()),
    modelChanging: false,
    chatEffort: 'high',
    handleEffortChange: vi.fn(() => Promise.resolve()),
    effortChanging: false,
    chatCollaboration: 'default',
    handleCollaborationChange: vi.fn(() => Promise.resolve()),
    collaborationChanging: false,
    chatFastMode: false,
    handleFastModeChange: vi.fn(() => Promise.resolve()),
    fastModeChanging: false,
    ...over
  }
}

function setup(over: Partial<ChatComposerProps> = {}) {
  props = makeProps(over)
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatComposer {...props} />
    </QueryClientProvider>
  )
}

const textarea = () => screen.getByRole('textbox') as HTMLTextAreaElement
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name })

/** The switch in the same Display-option row as `label`. */
function switchFor(label: string): HTMLButtonElement {
  let el: HTMLElement | null = screen.getByText(label)
  while (el) {
    const found = el.querySelectorAll<HTMLButtonElement>('[role="switch"]')
    if (found.length === 1) return found[0]
    if (found.length > 1) break
    el = el.parentElement
  }
  throw new Error(`no switch for "${label}"`)
}

const openDisplay = () => fireEvent.click(button('Display'))

// jsdom has no layout: the autocomplete menu scrolls its selected row into view.
const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  mutate.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = originalScrollIntoView
})

describe('ChatComposer queue', () => {
  it('lists queued messages under "Up next" with their count', () => {
    setup({ queuedMessages: [queued('q1', 'first'), queued('q2', 'second')] })
    expect(screen.getByText('Up next · 2')).toBeDefined()
    expect(screen.getByText('first')).toBeDefined()
    expect(screen.getByText('second')).toBeDefined()
  })

  it('cancelling a queued message removes it by id', () => {
    setup({ queuedMessages: [queued('q1', 'first'), queued('q2', 'second')] })
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel queued message' })[1])
    expect(props.removeQueue).toHaveBeenCalledWith('q2')
  })

  it('shows no queue section when nothing is queued', () => {
    setup()
    expect(screen.queryByText(/Up next/)).toBeNull()
  })
})

describe('ChatComposer attachments', () => {
  it('shows a chip per attachment (name + size); removing one drops only that index', () => {
    const other = att('b', 'notes.md', { kind: 'text', mediaType: 'text/plain', size: 300 })
    setup({ attachments: [IMG, other] })
    expect(screen.getByText('shot.png')).toBeDefined()
    expect(screen.getByText('2 KB')).toBeDefined()
    expect(screen.getByText('notes.md')).toBeDefined()
    fireEvent.click(screen.getAllByRole('button', { name: /Remove/ })[0])
    const update = vi.mocked(props.setAttachments).mock.lastCall?.[0]
    expect(typeof update).toBe('function')
    if (typeof update !== 'function') return
    expect(update([IMG, other])).toEqual([other])
  })

  it('shows each file still being attached', () => {
    setup({
      attachmentsApi: { ...makeProps().attachmentsApi, pending: [{ key: 'k', name: 'big.pdf' }] }
    })
    expect(screen.getByText(/Attaching big\.pdf/)).toBeDefined()
  })

  it('pasting goes to the attachments hook (it decides what to take)', () => {
    setup()
    fireEvent.paste(textarea(), { clipboardData: { files: [] } })
    expect(props.attachmentsApi.onPaste).toHaveBeenCalled()
  })

  it('Claude: the paperclip picks files for the attachments hook', () => {
    setup()
    const input = screen.getByTestId('chat-attach-input') as HTMLInputElement
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(props.attachmentsApi.addFiles).toHaveBeenCalledWith([file])
    expect(button('Attach files')).toBeDefined()
  })

  it('Codex: no file picker (images by paste/drop only, as before)', () => {
    setup({ mode: 'codex-chat' })
    expect(queryButton('Attach files')).toBeNull()
  })
})

describe('ChatComposer textarea', () => {
  it('typing updates the draft and the cursor position', () => {
    setup()
    fireEvent.change(textarea(), { target: { value: 'hey' } })
    expect(props.setDraft).toHaveBeenCalledWith('hey')
    expect(props.setCursorPos).toHaveBeenCalledWith(3)
  })

  it('forwards key presses to onKeyDown', () => {
    setup()
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(props.onKeyDown).toHaveBeenCalled()
  })

  it('a mouse-picked autocomplete row is accepted and the textarea refocused', () => {
    const source: AutocompleteSource<string> = {
      id: 'skills',
      detect: () => null,
      fetch: () => Promise.resolve([]),
      filter: (items) => items,
      getKey: (item) => item,
      render: (item) => item,
      accept: () => {}
    }
    const base = makeProps().autocomplete
    setup({
      autocomplete: {
        ...base,
        show: true,
        active: {
          match: { query: 'r', tokenStart: 0, tokenEnd: 2 },
          entries: [
            { item: 'review', source: source as AutocompleteSource },
            { item: 'refactor', source: source as AutocompleteSource }
          ],
          leadSourceId: 'skills'
        }
      }
    })
    fireEvent.mouseDown(screen.getByRole('option', { name: 'refactor' }))
    expect(props.autocomplete.accept).toHaveBeenCalledWith(1)
    expect(document.activeElement).toBe(textarea())
  })
})

describe('ChatComposer send / stop', () => {
  it('Send is disabled for an empty draft', () => {
    setup({ draft: '   ' })
    expect(button('Send').disabled).toBe(true)
  })

  it('Send is enabled with text and sends on click', () => {
    setup({ draft: 'hi' })
    const send = button('Send')
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(props.handleSend).toHaveBeenCalled()
  })

  it('Send is enabled with only an attachment', () => {
    setup({ attachments: [IMG] })
    expect(button('Send').disabled).toBe(false)
  })

  it('Send is disabled while a file is being attached', () => {
    setup({
      draft: 'hi',
      attachmentsApi: { ...makeProps().attachmentsApi, pending: [{ key: 'k', name: 'p.png' }] }
    })
    expect(button('Send').disabled).toBe(true)
  })

  it('while a turn runs, Stop replaces Send and stops on click', () => {
    setup({ inFlight: true, draft: 'hi' })
    expect(queryButton('Send')).toBeNull()
    fireEvent.click(button('Stop generation'))
    expect(props.handleStop).toHaveBeenCalled()
  })
})

describe('ChatComposer ended session', () => {
  it('disables the textarea and Send, with a "Session ended" placeholder', () => {
    setup({ displaySessionEnded: true, draft: 'hi' })
    expect(textarea().disabled).toBe(true)
    expect(textarea().placeholder).toBe('Session ended')
    expect(button('Send').disabled).toBe(true)
  })

  it('offers a restart button in place of the pills', () => {
    setup({ displaySessionEnded: true })
    expect(queryButton(/^Agent mode:/)).toBeNull()
    fireEvent.click(button('Session ended, click to restart'))
    expect(props.handleRestart).toHaveBeenCalled()
  })

  it('the restart button is disabled while restarting', () => {
    setup({ displaySessionEnded: true, restarting: true })
    expect(button('Restarting…').disabled).toBe(true)
  })
})

describe('ChatComposer pills', () => {
  it('mode, model and effort pills show when idle and are enabled', () => {
    setup()
    expect(button(/^Agent mode:/).disabled).toBe(false)
    expect(button(/^Chat model:/).disabled).toBe(false)
    expect(button(/^Reasoning effort:/).disabled).toBe(false)
  })

  it('mode, model and effort pills are disabled while a turn runs', () => {
    setup({ inFlight: true })
    expect(button(/^Agent mode:/).disabled).toBe(true)
    expect(button(/^Chat model:/).disabled).toBe(true)
    expect(button(/^Reasoning effort:/).disabled).toBe(true)
  })

  it('the model pill is disabled while a model change is applied', () => {
    setup({ modelChanging: true })
    expect(button(/^Chat model:/).disabled).toBe(true)
  })

  it('model and effort pills are hidden until the model is known', () => {
    setup({ chatModel: null })
    expect(queryButton(/^Chat model:/)).toBeNull()
    expect(queryButton(/^Reasoning effort:/)).toBeNull()
  })

  it('the effort pill is hidden for a model without an effort lever', () => {
    setup({ chatModel: 'haiku' })
    expect(queryButton(/^Reasoning effort:/)).toBeNull()
  })

  it('the collaboration pill shows for codex-chat only', () => {
    setup()
    expect(queryButton(/^Collaboration mode:/)).toBeNull()
    cleanup()
    setup({ mode: 'codex-chat', chatMode: 'auto-accept-edits', chatModel: 'gpt-5.5' })
    expect(button(/^Collaboration mode:/)).toBeDefined()
  })

  it('a rejected mode change is swallowed', async () => {
    setup({ handleModeChange: vi.fn(() => Promise.reject(new Error('respawn failed'))) })
    fireEvent.keyDown(button(/^Agent mode:/), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: /Plan mode/ }))
    expect(props.handleModeChange).toHaveBeenCalledWith('plan')
    // An unhandled rejection here would fail the run.
    await act(() => Promise.resolve())
  })

  it('the wide layout shows the send hint, which says "queue" while a turn runs', () => {
    const appearance = { ...appearanceDefaults, chatWidth: 'wide' as const }
    const { rerender } = setup({ appearance })
    expect(screen.getByText('Enter to send · Shift+Enter for newline')).toBeDefined()
    rerender(<ChatComposer {...makeProps({ appearance, inFlight: true })} />)
    expect(screen.getByText('Enter to queue · Shift+Enter for newline')).toBeDefined()
  })
})

describe('ChatComposer Display options', () => {
  it.each([
    ['Show tools', 'chat_show_tools'],
    ['File edits opened by default', 'chat_file_edits_open_by_default'],
    ['Show message meta', 'chat_show_message_meta']
  ])('"%s" writes %s and announces the change', (label, key) => {
    const changed = vi.fn()
    window.addEventListener('sz:settings-changed', changed)
    setup()
    openDisplay()
    fireEvent.click(switchFor(label))
    window.removeEventListener('sz:settings-changed', changed)
    expect(mutate).toHaveBeenCalledWith({ key, value: '0' })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('turning an option on writes "1"', () => {
    setup({ appearance: { ...appearanceDefaults, chatShowMessageMeta: false } })
    openDisplay()
    fireEvent.click(switchFor('Show message meta'))
    expect(mutate).toHaveBeenCalledWith({ key: 'chat_show_message_meta', value: '1' })
  })

  it('"Show last message tools" is disabled while all tools are shown', () => {
    setup()
    openDisplay()
    expect(switchFor('Show last message tools').disabled).toBe(true)
  })

  it('"Show last message tools" writes its key when tools are hidden', () => {
    setup({ appearance: { ...appearanceDefaults, chatShowTools: false } })
    openDisplay()
    const toggle = switchFor('Show last message tools')
    expect(toggle.disabled).toBe(false)
    fireEvent.click(toggle)
    expect(mutate).toHaveBeenCalledWith({ key: 'chat_show_last_message_tools', value: '0' })
  })
})

describe('ChatComposer Reset', () => {
  it('resets on click', () => {
    setup()
    fireEvent.click(button('Reset'))
    expect(props.handleReset).toHaveBeenCalled()
  })

  it('is disabled while a reset runs', () => {
    setup({ resetting: true })
    expect(button('Reset').disabled).toBe(true)
  })
})

describe('ChatComposer argument hint', () => {
  it('shows the hint as ghost text after the draft', () => {
    setup({ draft: '/x ', argumentHint: '<fruit> <count>' })
    const ghost = screen.getByTestId('chat-argument-hint')
    expect(ghost.textContent).toContain('<fruit> <count>')
  })

  it('no hint, no ghost', () => {
    setup({ draft: '/x ' })
    expect(screen.queryByTestId('chat-argument-hint')).toBeNull()
  })
})
