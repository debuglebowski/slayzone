// @vitest-environment jsdom
import { StrictMode, useEffect } from 'react'
import { afterEach, expect, test } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  ChatRestorationBoundary,
  useChatRestorationTracker,
  useChatRestorationQueries
} from './chat-restoration'

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
    const track = useChatRestorationTracker()
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

test('unmounting a panel keeps its query counted until the actual request settles', async () => {
  const client = {},
    started: number[] = []
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const work = Array.from({ length: 3 }, deferred)
  function Chat({ id }: { id: number }) {
    useQuery({
      queryKey: [['chat', 'metadata'], { input: { tabId: 'b' + id } }],
      queryFn: () => {
        started.push(id)
        return work[id]!.promise.then(() => id)
      }
    })
    useChatRestorationQueries({ taskId: 't' + id, tabId: 'b' + id, mode: 'claude-chat' })
    return <span>{id}</span>
  }
  const tree = (hideFirst: boolean) => (
    <QueryClientProvider client={queries}>
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
    </QueryClientProvider>
  )
  const view = render(tree(false))
  expect(started).toEqual([0, 1])
  view.rerender(tree(true))
  expect(started).toEqual([0, 1])
  await act(async () => {
    work[0]!.resolve()
    await settle()
  })
  await waitFor(() => expect(started).toEqual([0, 1, 2]))
  queries.clear()
})

test('a query started after mount keeps capacity even when its panel immediately unmounts', async () => {
  const client = {},
    started: number[] = []
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const work = Array.from({ length: 3 }, deferred)
  const late = deferred()
  function Chat({ id }: { id: number }) {
    const track = useChatRestorationTracker()
    useEffect(() => {
      started.push(id)
      void track(work[id]!.promise)
    }, [id, track])
    useChatRestorationQueries({ taskId: 't' + id, tabId: 'b' + id, mode: 'claude-chat' })
    return <span>{id}</span>
  }
  const tree = (hideFirst: boolean) => (
    <QueryClientProvider client={queries}>
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
    </QueryClientProvider>
  )
  try {
    const view = render(tree(false))
    expect(started).toEqual([0, 1])
    await act(async () => {
      // TanStack publishes its fetch action before assigning query.promise.
      void queries
        .fetchQuery({
          queryKey: [['chat', 'metadata'], { input: { tabId: 'b0' } }],
          queryFn: () => late.promise.then(() => 'metadata')
        })
        .catch(() => undefined)
      view.rerender(tree(true))
      work[0]!.resolve()
      await settle()
    })
    await act(settle)
    expect(started).toEqual([0, 1])
    await act(async () => {
      late.resolve()
      await settle()
    })
    await waitFor(() => expect(started).toEqual([0, 1, 2]))
  } finally {
    queries.clear()
  }
})
