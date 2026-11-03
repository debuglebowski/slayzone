import { act, renderHook, waitFor } from '@testing-library/react-native'
import { chatCapabilitiesForMode, chatModelsView } from '@slayzone/terminal-contracts'
import { useChatComposer } from './useChatComposer'
import type { ChatSessionApi } from './useChatSession'
import type { ChatSettings } from './useChatSettings'
import type { SlashCommands } from './useSlashCommands'

jest.mock('../trpc', () => ({ useTRPCClient: () => ({ chat: {} }) }))
jest.mock('./Markdown', () => ({ openWebLink: jest.fn() }))

function props(push: jest.Mock) {
  return {
    target: {
      tabId: 'tab',
      taskId: 'task',
      mode: 'claude-chat',
      cwd: '/w',
      providerFlagsOverride: null
    },
    caps: chatCapabilitiesForMode('claude-chat'),
    session: {
      inFlight: true,
      sendMessage: jest.fn(),
      abortAndPop: jest.fn(async () => ({ popped: false }))
    } as unknown as ChatSessionApi,
    queue: {
      items: [],
      push,
      clear: jest.fn(async () => {}),
      remove: jest.fn(async () => {}),
      steer: jest.fn(async () => ({ ok: true as const }))
    },
    settings: { model: 'opus' } as ChatSettings,
    models: chatModelsView('claude-chat', undefined),
    slash: { items: [], usage: {}, commands: [], bump: jest.fn() } as unknown as SlashCommands,
    notify: jest.fn(),
    sessionEnded: false
  }
}

it('retains rejected queued text and preserves newer edits while an acknowledgement is pending', async () => {
  let reject!: (err: Error) => void
  const push = jest.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      })
  )
  const options = props(push)
  const { result } = await renderHook(() => useChatComposer(options))
  await act(async () => {
    result.current.setDraft('first queued message')
  })
  await act(async () => {
    result.current.send()
  })
  expect(result.current.draft).toBe('first queued message')
  await act(async () => {
    reject(new Error('Computer offline'))
  })
  await waitFor(() => expect(options.notify).toHaveBeenCalled())
  expect(result.current.draft).toBe('first queued message')
  await act(async () => {
    result.current.send()
  })
  await act(async () => {
    result.current.setDraft('newer edit')
  })
  await act(async () => {
    reject(new Error('Computer offline'))
  })
  expect(result.current.draft).toBe('newer edit')
  expect(options.session.sendMessage).not.toHaveBeenCalled()
})

it('successful queue acknowledgement clears only the submitted revision', async () => {
  let resolve!: () => void
  const options = props(
    jest.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
  )
  const { result } = await renderHook(() => useChatComposer(options))
  await act(async () => {
    result.current.setDraft('queued')
  })
  await act(async () => {
    result.current.send()
  })
  await act(async () => {
    result.current.setDraft('typed meanwhile')
  })
  await act(async () => {
    resolve()
  })
  expect(result.current.draft).toBe('typed meanwhile')
})

it('rejected queued submission keeps attachment references too', async () => {
  const options = props(
    jest.fn(async () => {
      throw new Error('Computer offline')
    })
  )
  const file = {
    artifactId: 'file',
    name: 'context.txt',
    kind: 'text' as const,
    mediaType: 'text/plain' as const,
    size: 5
  }
  options.session.abortAndPop = jest.fn(async () => ({
    popped: true,
    text: 'restored',
    id: 'old',
    content: [{ type: 'attachment' as const, attachment: file }]
  }))
  const { result } = await renderHook(() => useChatComposer(options))
  await act(async () => {
    result.current.stop()
  })
  await waitFor(() => expect(result.current.attachments).toEqual([file]))
  await act(async () => {
    result.current.setDraft('with file')
    result.current.send()
  })
  await waitFor(() => expect(options.notify).toHaveBeenCalled())
  expect(result.current.attachments).toEqual([file])
  expect(result.current.draft).toBe('with file')
})
