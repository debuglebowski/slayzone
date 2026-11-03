// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { draftJournalKey, useChatDraftPersistence } from './useChatDraftPersistence'

const state = vi.hoisted(() => ({ reads: 0, writes: 0, offline: true }))
vi.mock('@slayzone/transport/client', () => ({ useHubId: () => 'review-hub' }))
vi.mock('../../trpc', () => ({
  useTRPC: () => ({
    chat: {
      tabState: {
        get: {
          queryOptions: () => ({
            queryKey: ['review-draft'],
            queryFn: async () => {
              state.reads++
              if (state.offline) throw new Error('Computer offline')
              return null
            }
          })
        }
      }
    }
  }),
  useTRPCClient: () => ({
    chat: {
      tabState: {
        saveDraft: {
          mutate: async () => {
            state.writes++
            throw new Error('Computer offline')
          }
        }
      }
    }
  })
}))

beforeEach(() => {
  state.reads = 0
  state.writes = 0
  state.offline = true
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

test('review: typing before an offline draft load must journal the only local copy', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const h = renderHook(
    ({ text }) =>
      useChatDraftPersistence({
        tabId: 'tab',
        enabled: true,
        text,
        attachments: [],
        paused: false
      }),
    { wrapper, initialProps: { text: '' } }
  )
  await waitFor(() => expect(client.getQueryState(['review-draft'])?.status).toBe('error'))
  h.rerender({ text: 'only copy typed while computer offline' })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350))
  })
  expect(h.result.current.loaded).toBe(false)
  expect(state.writes).toBe(0)
  h.unmount()
  expect(
    JSON.parse(localStorage.getItem(draftJournalKey('tab', 'review-hub')) ?? 'null')
  ).toMatchObject({ text: 'only copy typed while computer offline' })
  client.clear()
})

test('review control: a draft loaded before disconnect stays journaled when saving fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  state.offline = false
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const h = renderHook(
    ({ text }) =>
      useChatDraftPersistence({
        tabId: 'tab',
        enabled: true,
        text,
        attachments: [],
        paused: false
      }),
    { wrapper, initialProps: { text: '' } }
  )
  await waitFor(() => expect(h.result.current.loaded).toBe(true))
  state.offline = true
  h.rerender({ text: 'draft loaded before disconnect' })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350))
  })
  expect(state.writes).toBe(1)
  h.unmount()
  expect(
    JSON.parse(localStorage.getItem(draftJournalKey('tab', 'review-hub')) ?? 'null')
  ).toMatchObject({ text: 'draft loaded before disconnect' })
  client.clear()
})
