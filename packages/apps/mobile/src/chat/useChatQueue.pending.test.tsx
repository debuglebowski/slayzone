import { act, renderHook, waitFor } from '@testing-library/react-native'
import type { QueuedSubmission } from '@slayzone/task-terminals/queued-submissions'
import { trpcTest } from '../testing'
import { fakeHub } from './fake-hub'
import { useChatQueue } from './useChatQueue'

const mockRecords = new Map<string, QueuedSubmission>()
jest.mock('./queued-submission-journal', () => ({
  createQueuedSubmissionJournal: (hub: string, tab: string) => {
    const prefix = JSON.stringify([hub, tab]) + ':'
    return {
      list: async () =>
        [...mockRecords].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value),
      put: async (entry: QueuedSubmission) => {
        mockRecords.set(prefix + entry.id, JSON.parse(JSON.stringify(entry)))
      },
      remove: async (id: string) => {
        mockRecords.delete(prefix + id)
      }
    }
  }
}))
beforeEach(() => mockRecords.clear())

it('mobile lost ACK retains text/files across remount; explicit retry uses the original ID', async () => {
  const hub = fakeHub({ tabId: 'tab', taskId: 'task' })
  const { wrapper } = trpcTest(hub.backend)
  let loseAck = true
  const accepted = new Set<string>()
  hub.on('chat.queue.push', (input) => {
    accepted.add(input.id)
    if (loseAck) throw new Error('Acknowledgement lost')
    return null
  })
  const first = await renderHook(() => useChatQueue('tab'), { wrapper })
  const content = [
    {
      type: 'attachment' as const,
      attachment: {
        artifactId: 'file',
        name: 'context.txt',
        kind: 'text' as const,
        mediaType: 'text/plain' as const,
        size: 1
      }
    }
  ]
  await act(async () => {
    await first.result.current.push('queued', 'queued', content).catch(() => {})
  })
  const id = hub.callsTo('chat.queue.push')[0].id
  expect(first.result.current.pending).toMatchObject([{ id, content, state: 'failed' }])
  await first.unmount()
  const reopened = await renderHook(() => useChatQueue('tab'), { wrapper })
  await waitFor(() => expect(reopened.result.current.pending).toHaveLength(1))
  expect(hub.callsTo('chat.queue.push')).toHaveLength(1)
  loseAck = false
  await act(async () => {
    await reopened.result.current.retryPending?.(id)
  })
  expect(hub.callsTo('chat.queue.push').map((input) => input.id)).toEqual([id, id])
  expect(accepted.size).toBe(1)
  expect(reopened.result.current.pending).toEqual([])
  expect(mockRecords.size).toBe(0)
})

it('retains the original provider on pending retry after the selected provider changes', async () => {
  const hub = fakeHub({ tabId: 'tab', taskId: 'task' })
  const { wrapper } = trpcTest(hub.backend)
  hub.on('chat.queue.push', () => {
    throw new Error('Offline')
  })
  const first = await renderHook(() => useChatQueue('tab', undefined, 'claude-chat'), { wrapper })
  await act(async () => {
    await first.result.current.push('same text', 'same text').catch(() => {})
  })
  const id = hub.callsTo('chat.queue.push')[0].id
  await first.unmount()
  hub.on('chat.queue.push', (input) => {
    if (input.expectedMode !== 'codex-chat') throw new Error('Provider changed')
    return null
  })
  const next = await renderHook(() => useChatQueue('tab', undefined, 'codex-chat'), { wrapper })
  await waitFor(() => expect(next.result.current.pending).toHaveLength(1))
  await act(async () => {
    await next.result.current.retryPending?.(id).catch(() => {})
  })
  expect(hub.callsTo('chat.queue.push').at(-1)).toMatchObject({ id, expectedMode: 'claude-chat' })
  expect(next.result.current.pending).toMatchObject([
    { id, state: 'failed', error: 'Provider changed' }
  ])
  await act(async () => {
    await next.result.current.push('same text', 'same text')
  })
  expect(hub.callsTo('chat.queue.push').at(-1)).toMatchObject({ expectedMode: 'codex-chat' })
  expect(hub.callsTo('chat.queue.push').at(-1).id).not.toBe(id)
})
