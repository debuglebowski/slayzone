// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useChatQueue } from './useChatQueue'

const server = vi.hoisted(() => ({ calls: [] as Array<{ id: string }>, loseAck: true }))
vi.mock('@slayzone/transport/client', () => ({ useHubId: () => 'hub', useSubscription: () => {} }))
vi.mock('../trpc', () => {
  const client = {
    chat: {
      queue: {
        push: {
          mutate: async (input: { id: string }) => {
            server.calls.push(input)
            if (server.loseAck) throw new Error('Acknowledgement lost')
          }
        }
      }
    }
  }
  return {
    useTRPCClient: () => client,
    useTRPC: () => ({
      chat: {
        onQueueChanged: { subscriptionOptions: () => ({}) },
        onQueueDrained: { subscriptionOptions: () => ({}) },
        queue: {
          list: {
            queryOptions: () => ({ queryKey: ['queue'], queryFn: async () => [] }),
            queryFilter: () => ({ queryKey: ['queue'] })
          }
        }
      }
    })
  }
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  server.calls = []
  server.loseAck = true
})

test('desktop retry after remount reuses durable client ID and does not automatically send on reopening', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const first = renderHook(() => useChatQueue('tab'), { wrapper })
  await act(async () => {
    await first.result.current.push('queued', 'queued').catch(() => {})
  })
  // Saved first, delivered in the background: the lost acknowledgement shows on the entry.
  await waitFor(() => expect(server.calls).toHaveLength(1))
  const id = server.calls[0].id
  await waitFor(() => expect(first.result.current.pending).toMatchObject([{ id, state: 'failed' }]))
  first.unmount()
  const reopened = renderHook(() => useChatQueue('tab'), { wrapper })
  await waitFor(() => expect(reopened.result.current.pending).toHaveLength(1))
  expect(server.calls).toHaveLength(1)
  server.loseAck = false
  await act(async () => {
    await reopened.result.current.retryPending(id)
  })
  await waitFor(() => expect(reopened.result.current.pending).toEqual([]))
  expect(server.calls.map((call) => call.id)).toEqual([id, id])
  expect(reopened.result.current.pending).toEqual([])
  expect(localStorage.length).toBe(0)
  client.clear()
})
