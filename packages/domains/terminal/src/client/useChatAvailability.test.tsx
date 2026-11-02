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
