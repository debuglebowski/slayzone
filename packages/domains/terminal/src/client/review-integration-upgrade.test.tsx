// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useChatAvailability } from './useChatAvailability'
import { ChatSync } from '../../../../apps/mobile/src/chat/chat-sync'
import { initialState, reducer } from '@slayzone/terminal/reducer'
import type { ChatAvailability } from '@slayzone/terminal-contracts'

const hub = vi.hoisted(() => ({ online: true, calls: 0, generation: 'boot:0' }))
vi.mock('@slayzone/transport/client', async () => ({
  ...(await vi.importActual<typeof import('@slayzone/transport/client')>(
    '@slayzone/transport/client'
  )),
  useSubscription: () => {}
}))
vi.mock('./trpc', () => ({
  useTRPC: () => ({
    chat: {
      availability: {
        queryOptions: ({ tabId }: { tabId: string }) => ({
          queryKey: ['review-availability', tabId],
          queryFn: async () => {
            hub.calls++
            return {
              state: hub.online ? 'ready' : 'offline',
              computer: { id: 'pc', name: 'Review' },
              recoveryGeneration: hub.generation
            } as ChatAvailability
          }
        })
      },
      onReplayRequired: { subscriptionOptions: (_input: unknown, options: object) => options }
    }
  })
}))
afterEach(cleanup)
beforeEach(() => {
  hub.online = true
  hub.calls = 0
  hub.generation = 'boot:0'
})

test.each([false, true])(
  'review: computer reconnect refreshes missed history, sampledOffline=%s',
  async (sampledOffline) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children)
    let timeline = initialState()
    const sync = new ChatSync('tab', {
      dispatch: (action) => {
        timeline = reducer(timeline, action)
      },
      requestFrame: () => {},
      cancelFrame: () => {}
    })
    sync.completeLoad(sync.beginLoad('full'), {
      events: [],
      live: { afterSeq: -1, liveSeq: 0, events: [] }
    })
    const saved = [
      {
        seq: 0,
        event: {
          kind: 'user-message',
          id: 'offline-message',
          text: 'persisted on computer during disconnect',
          content: [{ type: 'text', text: 'persisted on computer during disconnect' }]
        }
      }
    ]
    const reload = vi.fn(() =>
      sync.completeLoad(sync.beginLoad('full'), {
        events: saved,
        live: { afterSeq: 0, liveSeq: 0, events: [] }
      })
    )
    const h = renderHook(
      () =>
        useChatAvailability({
          tabId: 'tab',
          active: true,
          historyReady: true,
          onReady: reload
        }),
      { wrapper }
    )
    await waitFor(() => expect(h.result.current.status?.state).toBe('ready'))
    // The renderer-to-hub subscription remains alive. Computer link briefly drops,
    // misses its content notification, and reconnects before the 15s status poll.
    hub.online = false
    if (sampledOffline) {
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['review-availability'] })
      })
      await waitFor(() => expect(h.result.current.status?.state).toBe('offline'))
    }
    hub.online = true
    hub.generation = 'boot:1'
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['review-availability'] })
    })
    expect(hub.calls).toBeGreaterThanOrEqual(2)
    await waitFor(() => expect(h.result.current.status?.state).toBe('ready'))
    await waitFor(() =>
      expect(
        timeline.timeline.some(
          (item) => item?.kind === 'user-text' && item.id === 'offline-message'
        )
      ).toBe(true)
    )
    client.clear()
  }
)
