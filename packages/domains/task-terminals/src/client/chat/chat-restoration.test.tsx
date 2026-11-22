// @vitest-environment jsdom
import { StrictMode, useEffect } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ChatAvailability } from '@slayzone/terminal-contracts'
import {
  ChatRestorationBoundary,
  useChatHistoryReadiness,
  useChatHistoryTracker
} from './chat-restoration'

const readAvailability = vi.hoisted(() => vi.fn<(tabId: string) => Promise<ChatAvailability>>())
vi.mock('../trpc', () => ({
  useTRPC: () => ({
    chat: {
      availability: {
        queryOptions: ({ tabId }: { tabId: string }) => ({
          queryKey: ['chat', 'availability', tabId],
          queryFn: () => readAvailability(tabId)
        })
      }
    }
  })
}))

const pending: Array<() => void> = []
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  pending.push(resolve)
  return { promise, resolve }
}
const settle = async () => {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}
afterEach(async () => {
  cleanup()
  for (const resolve of pending.splice(0)) resolve()
  await settle()
})

test('strict effect cleanup can re-admit a panel without retaining a cancelled ticket', async () => {
  const client = {}
  const view = render(
    <StrictMode>
      <ChatRestorationBoundary client={client} taskId="strict" tabId="strict-tab" active>
        <span>Chat ready</span>
      </ChatRestorationBoundary>
    </StrictMode>
  )
  await waitFor(() => expect(view.getByText('Chat ready')).toBeTruthy())
})

test('mounted panels register async work before admission advances; revealing a queued tab promotes it', async () => {
  const client = {},
    started: number[] = []
  const work = Array.from({ length: 70 }, deferred)
  function Chat({ id }: { id: number }) {
    const track = useChatHistoryTracker()
    useEffect(() => {
      started.push(id)
      void track(work[id]!.promise)
    }, [id, track])
    return <span>{id}</span>
  }
  const tree = (active: number) => (
    <>
      {work.map((_, id) => (
        <ChatRestorationBoundary
          key={id}
          client={client}
          taskId={'t' + id}
          tabId={'b' + id}
          active={id === active}
        >
          <Chat id={id} />
        </ChatRestorationBoundary>
      ))}
    </>
  )
  const view = render(tree(-1))
  expect(started).toEqual([0, 1])
  view.rerender(tree(69))
  expect(started).toEqual([0, 1, 69])
  await act(async () => {
    work[0]!.resolve()
    await settle()
  })
  await waitFor(() => expect(started).toEqual([0, 1, 69, 2]))
})

test('unmounting a panel keeps its history counted until the actual request settles', async () => {
  const client = {},
    started: number[] = []
  const work = Array.from({ length: 3 }, deferred)
  function Chat({ id }: { id: number }) {
    const track = useChatHistoryTracker()
    useEffect(() => {
      started.push(id)
      void track(work[id]!.promise)
    }, [id, track])
    return <span>{id}</span>
  }
  const tree = (hideFirst: boolean) => (
    <>
      {work.map((_, id) =>
        hideFirst && id === 0 ? null : (
          <ChatRestorationBoundary
            key={id}
            client={client}
            taskId={'t' + id}
            tabId={'b' + id}
            active={false}
          >
            <Chat id={id} />
          </ChatRestorationBoundary>
        )
      )}
    </>
  )
  const view = render(tree(false))
  expect(started).toEqual([0, 1])
  view.rerender(tree(true))
  await act(settle)
  expect(started).toEqual([0, 1])
  await act(async () => work[0]!.resolve())
  await waitFor(() => expect(started).toEqual([0, 1, 2]))
})

test('a mounted chat keeps rendering and releases its slot while metadata is pending', async () => {
  const client = {},
    started: number[] = []
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const work = Array.from({ length: 3 }, deferred)
  const late = deferred()
  function Chat({ id }: { id: number }) {
    const track = useChatHistoryTracker()
    useEffect(() => {
      started.push(id)
      void track(work[id]!.promise)
    }, [id, track])
    useQuery({
      queryKey: [['chat', 'metadata'], { input: { tabId: 'b' + id } }],
      queryFn: () => late.promise.then(() => id)
    })
    return <span>{id}</span>
  }
  try {
    const view = render(
      <QueryClientProvider client={queries}>
        {work.map((_, id) => (
          <ChatRestorationBoundary
            key={id}
            client={client}
            taskId={'t' + id}
            tabId={'b' + id}
            active={false}
          >
            <Chat id={id} />
          </ChatRestorationBoundary>
        ))}
      </QueryClientProvider>
    )
    expect(started).toEqual([0, 1])
    await act(async () => work[0]!.resolve())
    await waitFor(() => expect(started).toEqual([0, 1, 2]))
    expect(view.getByText('0')).toBeDefined()
    expect(queries.isFetching()).toBe(3)
  } finally {
    queries.clear()
  }
})

test('a booting computer consumes no history lane and rejoins behind already admitted chats', async () => {
  const client = {}
  const work = Array.from({ length: 3 }, deferred)
  const started: number[] = []
  function Chat({ id }: { id: number }) {
    const track = useChatHistoryTracker()
    useEffect(() => {
      started.push(id)
      void track(work[id]!.promise)
    }, [id, track])
    return <span>Chat {id}</span>
  }
  const tree = (waitingForComputer: boolean) => (
    <>
      {work.map((_, id) => (
        <ChatRestorationBoundary
          key={id}
          client={client}
          taskId={'t' + id}
          tabId={'b' + id}
          active={false}
          computerReadiness={id === 0 && waitingForComputer ? 'waiting' : 'ready'}
        >
          <Chat id={id} />
        </ChatRestorationBoundary>
      ))}
    </>
  )
  const view = render(tree(true))
  expect(started).toEqual([1, 2])
  expect(view.getByRole('status').textContent).toBe('Waiting for computer…')

  view.rerender(tree(false))
  expect(started).toEqual([1, 2])
  await act(async () => work[1]!.resolve())
  await waitFor(() => expect(started).toEqual([1, 2, 0]))

  // Losing readiness after admission keeps the mounted chat and its local state.
  view.rerender(tree(true))
  expect(view.getByText('Chat 0')).toBeDefined()
  expect(started).toEqual([1, 2, 0])
})

test.each(['ready', 'error'] as const)(
  'a %s readiness refresh lets the normal history open proceed',
  async (outcome) => {
    const queries = new QueryClient()
    const browserClient = {}
    const booting = {
      state: 'offline',
      computer: { id: 'pc', name: 'Computer' },
      historyWaiting: true
    } as const
    readAvailability.mockResolvedValueOnce(booting)
    if (outcome === 'ready') {
      readAvailability.mockResolvedValueOnce({ state: 'ready', computer: booting.computer })
    } else {
      readAvailability.mockRejectedValueOnce(new Error('readiness request unavailable'))
    }
    function Chat() {
      const computerReadiness = useChatHistoryReadiness('t')
      return (
        <ChatRestorationBoundary
          client={browserClient}
          taskId="p"
          tabId="t"
          active
          computerReadiness={computerReadiness}
        >
          <span>Chat opened</span>
        </ChatRestorationBoundary>
      )
    }
    try {
      const view = render(
        <QueryClientProvider client={queries}>
          <Chat />
        </QueryClientProvider>
      )
      expect(view.queryByText('Chat opened')).toBeNull()
      await view.findByText('Waiting for computer…')
      await act(async () => queries.refetchQueries({ queryKey: ['chat', 'availability', 't'] }))
      expect(await view.findByText('Chat opened')).toBeDefined()
      expect(readAvailability).toHaveBeenCalledTimes(2)
    } finally {
      readAvailability.mockReset()
      cleanup()
      queries.clear()
    }
  }
)
