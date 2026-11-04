// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { chatModelsView, type ChatAttachment } from '@slayzone/terminal-contracts'
import type { ChatActions, NavigateActions } from './autocomplete/types'
import { useChatComposer } from './useChatComposer'

const mocks = vi.hoisted(() => ({ push: vi.fn(), toast: vi.fn() }))
vi.mock('../trpc', () => ({ useTRPCClient: () => ({ chat: {} }) }))
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../../shared/ui/src/use-stable-callback')),
  toast: mocks.toast
}))
vi.mock('./useChatQueue', () => ({
  useChatQueue: () => ({
    items: [],
    push: mocks.push,
    remove: vi.fn(),
    clear: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
    hold: vi.fn(),
    release: vi.fn()
  })
}))
vi.mock('./composer-state/useChatDraftPersistence', () => ({
  useChatDraftPersistence: () => ({
    loaded: true,
    saved: null,
    retry: () => {},
    legacyAvailable: false,
    recoverLegacy: () => null
  })
}))
vi.mock('./usePromptHistory', () => ({
  usePromptHistory: () => ({ entries: [], record: () => {} })
}))
vi.mock('./autocomplete/useAutocomplete', () => ({
  useAutocomplete: () => ({
    show: false,
    active: null,
    selectedIndex: 0,
    setSelectedIndex: () => {},
    accept: () => {},
    close: () => {},
    handleKeyDown: () => false,
    transformSubmit: () => null,
    bumpUsageFromMessage: () => {}
  })
}))
afterEach(cleanup)

test.each([false, true])(
  'review: queue submission preserves input until accepted, offline=%s',
  async (offline) => {
    mocks.push.mockReset().mockImplementation(async () => {
      if (offline) throw new Error('Computer offline')
    })
    const sendMessage = vi.fn(async () => {})
    const { result } = renderHook(() =>
      useChatComposer({
        tabId: 'tab',
        taskId: 'task',
        mode: 'claude-chat',
        cwd: '/repo',
        isActive: false,
        sendMessage,
        inFlight: true,
        turnId: 0,
        sessionEnded: false,
        abortAndPop: async () => ({ popped: false, text: null, id: null, content: null }),
        chatApi: {} as ChatActions,
        navigate: {} as NavigateActions,
        getArtifactFilePath: async () => null,
        scrollToBottom: () => {},
        handleEffortChange: async () => {},
        models: chatModelsView('claude-chat', undefined),
        chatModel: 'opus',
        handleModelChange: async () => {},
        cliCommands: null
      })
    )
    const file: ChatAttachment = {
      artifactId: 'file',
      name: 'context.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: 5
    }
    act(() => {
      result.current.setDraft('keep unsent queued input')
      result.current.setAttachments([file])
    })
    await act(async () => {
      await result.current.handleSend().catch(() => {})
    })
    expect(mocks.push).toHaveBeenCalledWith(
      'keep unsent queued input',
      'keep unsent queued input',
      [
        { type: 'attachment', attachment: file },
        { type: 'text', text: 'keep unsent queued input' }
      ]
    )
    expect(sendMessage).not.toHaveBeenCalled()
    expect(result.current.draft).toBe(offline ? 'keep unsent queued input' : '')
    expect(result.current.attachments).toEqual(offline ? [file] : [])
  }
)
