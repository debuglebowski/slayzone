// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ChatAvailability } from '@slayzone/terminal-contracts'
import { useChatAvailability } from './useChatAvailability'
const hub = vi.hoisted(() => ({
  status: { state: 'ready', computer: { id: 'pc', name: 'Laptop' } } as ChatAvailability,
  error: null as Error | null,
  pending: null as Promise<ChatAvailability> | null,
  calls: 0
}))
vi.mock('./trpc', () => ({
  useTRPC: () => ({
    chat: {
      availability: {
        queryOptions: ({ tabId }: { tabId: string }) => ({
          queryKey: ['availability', tabId],
          queryFn: async () => {
            hub.calls++
            if (hub.pending) return hub.pending
            if (hub.error) throw hub.error
            return hub.status
          }
        })
      }
    }
  })
}))
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client }, children)
beforeEach(() => {
  hub.status = { state: 'ready', computer: { id: 'pc', name: 'Laptop' } }
  hub.error = null
  hub.pending = null
  hub.calls = 0
})
afterEach(() => {
  cleanup()
  client.clear()
})
const refetch = () =>
  act(async () => {
    await client.invalidateQueries({ queryKey: ['availability'] })
  })

test('initial ready status does not reopen a chat; offline to ready reopens once', async () => {
  const onReady = vi.fn()
  const { result } = renderHook(
    () => useChatAvailability({ tabId: 'tab', active: true, onReady }),
    { wrapper }
  )
  await waitFor(() => expect(result.current.status?.state).toBe('ready'))
  expect(onReady).not.toHaveBeenCalled()
  hub.status = { state: 'offline', computer: { id: 'pc', name: 'Laptop' } }
  await refetch()
  await waitFor(() => expect(result.current.status?.state).toBe('offline'))
  hub.status = { state: 'ready', computer: { id: 'pc', name: 'Laptop' } }
  await refetch()
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  await refetch()
  expect(onReady).toHaveBeenCalledTimes(1)
})
test('explicit Retry refreshes status and reloads once even when it reconnects', async () => {
  hub.status = { state: 'offline', computer: { id: 'pc', name: 'Laptop' } }
  const onReady = vi.fn()
  const { result } = renderHook(
    () => useChatAvailability({ tabId: 'tab', active: true, onReady }),
    { wrapper }
  )
  await waitFor(() => expect(result.current.status?.state).toBe('offline'))
  hub.status = { state: 'ready', computer: { id: 'pc', name: 'Laptop' } }
  await act(async () => {
    await result.current.retry()
  })
  await waitFor(() => expect(result.current.status?.state).toBe('ready'))
  expect(onReady).toHaveBeenCalledTimes(1)
})
test('hub errors keep their cause visible and recovery reloads the chat', async () => {
  const onReady = vi.fn()
  const { result } = renderHook(
    () => useChatAvailability({ tabId: 'tab', active: true, onReady }),
    { wrapper }
  )
  await waitFor(() => expect(result.current.status?.state).toBe('ready'))
  hub.error = new Error('hub unreachable')
  await refetch()
  await waitFor(() => expect(result.current.error).toBe('hub unreachable'))
  hub.error = null
  await refetch()
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
})
test('hidden tabs do not poll', async () => {
  const { result, rerender } = renderHook(
    ({ active }) => useChatAvailability({ tabId: 'tab', active, onReady: () => undefined }),
    { initialProps: { active: false }, wrapper }
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(hub.calls).toBe(0)
  rerender({ active: true })
  await waitFor(() => expect(result.current.status?.state).toBe('ready'))
})

test('successful history loading refreshes preparing immediately without loading history twice', async () => {
  hub.status = { state: 'preparing', computer: { id: 'pc', name: 'Laptop' } }
  const onReady = vi.fn()
  const { result, rerender } = renderHook(
    ({ historyReady }) =>
      useChatAvailability({ tabId: 'tab', active: true, historyReady, onReady }),
    { initialProps: { historyReady: false }, wrapper }
  )
  await waitFor(() => expect(result.current.status?.state).toBe('preparing'))
  expect(hub.calls).toBe(1)
  hub.status = { state: 'ready', computer: { id: 'pc', name: 'Laptop' } }
  rerender({ historyReady: true })
  // The successful load drives this request; no availability polling tick is needed.
  expect(hub.calls).toBe(2)
  await waitFor(() => expect(result.current.status?.state).toBe('ready'))
  expect(onReady).not.toHaveBeenCalled()

  // A later real disconnect still needs a fresh history load on reconnection.
  hub.status = { state: 'offline', computer: { id: 'pc', name: 'Laptop' } }
  await refetch()
  await waitFor(() => expect(result.current.status?.state).toBe('offline'))
  hub.status = { state: 'ready', computer: { id: 'pc', name: 'Laptop' } }
  await refetch()
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
})

test('successful history loading does not add a request when availability is already ready', async () => {
  const onReady = vi.fn()
  const { result, rerender } = renderHook(
    ({ historyReady }) =>
      useChatAvailability({ tabId: 'tab', active: true, historyReady, onReady }),
    { initialProps: { historyReady: false }, wrapper }
  )
  await waitFor(() => expect(result.current.status?.state).toBe('ready'))
  rerender({ historyReady: true })
  expect(hub.calls).toBe(1)
  expect(onReady).not.toHaveBeenCalled()
})

test('a post-load status failure remains visible and subsequent recovery reloads history', async () => {
  hub.status = { state: 'preparing', computer: { id: 'pc', name: 'Laptop' } }
  const onReady = vi.fn()
  const { result, rerender } = renderHook(
    ({ historyReady }) =>
      useChatAvailability({ tabId: 'tab', active: true, historyReady, onReady }),
    { initialProps: { historyReady: false }, wrapper }
  )
  await waitFor(() => expect(result.current.status?.state).toBe('preparing'))
  hub.error = new Error('computer disconnected during setup')
  rerender({ historyReady: true })
  expect(hub.calls).toBe(2)
  await waitFor(() => expect(result.current.error).toBe('computer disconnected during setup'))
  expect(onReady).not.toHaveBeenCalled()
  hub.error = null
  hub.status = { state: 'ready', computer: { id: 'pc', name: 'Laptop' } }
  await refetch()
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
})

test('history loaded while hidden refreshes availability only when the tab becomes active', async () => {
  const onReady = vi.fn()
  const { result, rerender } = renderHook(
    ({ active }) => useChatAvailability({ tabId: 'tab', active, historyReady: true, onReady }),
    { initialProps: { active: false }, wrapper }
  )
  expect(hub.calls).toBe(0)
  rerender({ active: true })
  await waitFor(() => expect(result.current.status?.state).toBe('ready'))
  expect(hub.calls).toBe(1)
  expect(onReady).not.toHaveBeenCalled()
})

test('a previous tab’s delayed post-load refresh cannot swallow the current tab’s reconnect', async () => {
  hub.status = { state: 'preparing', computer: { id: 'pc', name: 'Laptop' } }
  const onReady = vi.fn()
  const { result, rerender } = renderHook(
    ({ tabId, historyReady }) =>
      useChatAvailability({ tabId, active: true, historyReady, onReady }),
    { initialProps: { tabId: 'old', historyReady: false }, wrapper }
  )
  await waitFor(() => expect(result.current.status?.state).toBe('preparing'))
  let resolve!: (status: ChatAvailability) => void
  hub.pending = new Promise((done) => {
    resolve = done
  })
  rerender({ tabId: 'old', historyReady: true })
  expect(hub.calls).toBe(2)
  hub.pending = null
  hub.status = { state: 'offline', computer: { id: 'pc', name: 'Laptop' } }
  rerender({ tabId: 'new', historyReady: false })
  await waitFor(() => expect(result.current.status?.state).toBe('offline'))
  await act(async () => {
    resolve({ state: 'ready', computer: { id: 'pc', name: 'Laptop' } })
  })
  expect(onReady).not.toHaveBeenCalled()
  hub.status = { state: 'ready', computer: { id: 'pc', name: 'Laptop' } }
  await refetch()
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
})

test('Retry during a post-load refresh still reloads once without another status request', async () => {
  hub.status = { state: 'preparing', computer: { id: 'pc', name: 'Laptop' } }
  const onReady = vi.fn()
  const { result, rerender } = renderHook(
    ({ historyReady }) =>
      useChatAvailability({ tabId: 'tab', active: true, historyReady, onReady }),
    { initialProps: { historyReady: false }, wrapper }
  )
  await waitFor(() => expect(result.current.status?.state).toBe('preparing'))
  let resolve!: (status: ChatAvailability) => void
  hub.pending = new Promise((done) => {
    resolve = done
  })
  rerender({ historyReady: true })
  expect(hub.calls).toBe(2)
  await act(async () => {
    await result.current.retry()
    resolve({ state: 'ready', computer: { id: 'pc', name: 'Laptop' } })
  })
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  expect(hub.calls).toBe(2)
})

test('history finishing before the initial status response still gets a fresh ready status', async () => {
  let resolve!: (status: ChatAvailability) => void
  hub.pending = new Promise((done) => {
    resolve = done
  })
  const onReady = vi.fn()
  const { result, rerender } = renderHook(
    ({ historyReady }) =>
      useChatAvailability({ tabId: 'tab', active: true, historyReady, onReady }),
    { initialProps: { historyReady: false }, wrapper }
  )
  expect(hub.calls).toBe(1)
  hub.pending = null
  hub.status = { state: 'ready', computer: { id: 'pc', name: 'Laptop' } }
  rerender({ historyReady: true })
  await act(async () => {
    // This earlier request observed the conversation before bootstrap completed.
    resolve({ state: 'preparing', computer: { id: 'pc', name: 'Laptop' } })
  })
  await waitFor(() => expect(hub.calls).toBe(2))
  await waitFor(() => expect(result.current.status?.state).toBe('ready'))
  expect(onReady).not.toHaveBeenCalled()
})
