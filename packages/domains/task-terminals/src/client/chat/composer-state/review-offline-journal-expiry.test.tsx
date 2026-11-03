// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { draftJournalKey, useChatDraftPersistence } from './useChatDraftPersistence'

vi.mock('@slayzone/transport/client', () => ({ useHubId: () => 'hub' }))
vi.mock('../../trpc', () => ({
  useTRPC: () => ({
    chat: {
      tabState: {
        get: {
          queryOptions: (input: { tabId: string }, opts: { enabled?: boolean }) => ({
            queryKey: ['draft', input.tabId],
            enabled: opts.enabled,
            queryFn: async () => ({
              draft: { text: '', attachments: [], rev: 0 },
              scroll: null,
              ownership: { id: 'online-owner', epoch: 1 }
            })
          })
        }
      }
    }
  }),
  useTRPCClient: () => ({ chat: { tabState: { saveDraft: { mutate: vi.fn() } } } })
}))
afterEach(() => {
  cleanup()
  localStorage.clear()
})

test('review: opening another online chat must not erase the only unresolved offline draft after seven days', async () => {
  const offlineKey = draftJournalKey('offline-tab', 'hub', 'claude-chat')
  const onlyCopy = {
    text: 'only offline copy; computer never loaded',
    attachments: [],
    baseRev: null,
    savedAt: Date.now() - 8 * 86_400_000
  }
  localStorage.setItem(offlineKey, JSON.stringify(onlyCopy))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(
    () =>
      useChatDraftPersistence({
        tabId: 'different-online-tab',
        mode: 'claude-chat',
        enabled: true,
        text: '',
        attachments: [],
        paused: false
      }),
    { wrapper }
  )
  await waitFor(() => expect(result.current.loaded).toBe(true))
  expect(localStorage.getItem(offlineKey)).not.toBeNull()
  expect(JSON.parse(localStorage.getItem(offlineKey)!)).toMatchObject(onlyCopy)
  client.clear()
})
