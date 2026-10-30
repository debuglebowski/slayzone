// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChatScrollAnchor, ChatTabState } from '@slayzone/terminal-contracts'
import type { CallbackRef } from '../useFollowBottom'

const server = vi.hoisted(() => ({
  state: null as ChatTabState | null,
  saves: [] as ChatScrollAnchor[]
}))

vi.mock('../../trpc', () => ({
  useTRPC: () => ({
    chat: {
      tabState: {
        get: {
          queryOptions: (input: { tabId: string }, opts?: { enabled?: boolean }) => ({
            queryKey: ['tabState', input.tabId],
            queryFn: async () => server.state,
            enabled: opts?.enabled ?? true
          })
        }
      }
    }
  }),
  useTRPCClient: () => ({
    chat: {
      tabState: {
        saveScroll: {
          mutate: async ({ anchor }: { anchor: ChatScrollAnchor }) => {
            server.saves.push(anchor)
          }
        }
      }
    }
  })
}))

import { useChatScrollMemory } from './useChatScrollMemory'

function scroller(): CallbackRef<HTMLElement> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ref = ((e: HTMLElement | null) => {
    ref.current = e
  }) as CallbackRef<HTMLElement>
  ref.current = el
  return ref
}

function setup(
  over: { ready?: boolean; enabled?: boolean; anchor?: ChatScrollAnchor | null } = {}
) {
  const scrollRef = scroller()
  const api = {
    captureAnchor: vi.fn<() => ChatScrollAnchor | null>(() => over.anchor ?? null),
    restoreAnchor: vi.fn<(a: ChatScrollAnchor) => boolean>(() => true),
    revealKey: vi.fn<(key: string) => void>()
  }
  const client = new QueryClient()
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    (p: { ready: boolean }) =>
      useChatScrollMemory({
        tabId: 'tab-1',
        enabled: over.enabled ?? true,
        ready: p.ready,
        scrollRef,
        ...api
      }),
    { wrapper, initialProps: { ready: over.ready ?? true } }
  )
  return { hook, api, el: scrollRef.current! }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  server.state = null
  server.saves = []
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('useChatScrollMemory', () => {
  it('restores the saved anchor once the timeline is there: reveal its row, then scroll to it', async () => {
    const anchor: ChatScrollAnchor = { atBottom: false, key: 'user:m3', offsetPx: 12 }
    server.state = { draft: { text: '', attachments: [], rev: 0 }, scroll: anchor }
    const { hook, api } = setup({ ready: false })
    await act(() => vi.advanceTimersByTimeAsync(50))
    expect(api.restoreAnchor).not.toHaveBeenCalled()
    hook.rerender({ ready: true })
    await vi.waitFor(() => expect(api.restoreAnchor).toHaveBeenCalledWith(anchor))
    expect(api.revealKey).toHaveBeenCalledWith('user:m3', undefined)
  })

  it('nothing saved / at the bottom: nothing to restore (the timeline follows the bottom)', async () => {
    server.state = { draft: { text: '', attachments: [], rev: 0 }, scroll: { atBottom: true } }
    const { api } = setup()
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(api.restoreAnchor).not.toHaveBeenCalled()
  })

  it('saves where the user scrolled after a pause, once per change', async () => {
    const { el, api } = setup({ anchor: { atBottom: false, key: 'text:m1', offsetPx: 4 } })
    await act(() => vi.advanceTimersByTimeAsync(50))
    fireEvent.scroll(el)
    fireEvent.scroll(el)
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(server.saves).toEqual([{ atBottom: false, key: 'text:m1', offsetPx: 4 }])
    fireEvent.scroll(el)
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(server.saves).toHaveLength(1)
    api.captureAnchor.mockReturnValue({ atBottom: true })
    fireEvent.scroll(el)
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(server.saves.at(-1)).toEqual({ atBottom: true })
  })

  it('disabled (Codex): no restore, no save', async () => {
    server.state = {
      draft: { text: '', attachments: [], rev: 0 },
      scroll: { atBottom: false, key: 'x', offsetPx: 0 }
    }
    const { el, api } = setup({ enabled: false, anchor: { atBottom: true } })
    fireEvent.scroll(el)
    await act(() => vi.advanceTimersByTimeAsync(700))
    expect(api.restoreAnchor).not.toHaveBeenCalled()
    expect(server.saves).toEqual([])
  })
})
