// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Pins the default agent the Providers and Agent-panel sections share: seeded from
 * the hub's `default_agent_id`, a local pick kept until new data, every pick saved.
 * Ported from the dialog, which owned this state before it became hub-scoped.
 */

let storedMode: string | null = 'codex'
let mutations: Array<{ path: string; input: unknown }> = []

vi.mock('../trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    settings: {
      get: {
        queryOptions: (input: unknown, opts?: Record<string, unknown>) => ({
          queryKey: ['settings.get', input],
          queryFn: async () => storedMode,
          ...opts
        })
      },
      set: {
        mutationOptions: (opts?: Record<string, unknown>) => ({
          mutationFn: async (input: unknown) => {
            mutations.push({ path: 'settings.set', input })
            return null
          },
          ...opts
        })
      }
    }
  })
}))
vi.mock('@slayzone/ui', () => ({ toast: { error: vi.fn() } }))

const { useDefaultAgent } = await import('./use-default-agent')

let queryClient: QueryClient
const wrapper = ({ children }: { children?: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  storedMode = 'codex'
  mutations = []
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe('useDefaultAgent', () => {
  it('seeds from the stored setting, keeps a local pick until new data, saves picks', async () => {
    const { result } = renderHook(() => useDefaultAgent(), { wrapper })
    expect(result.current.defaultAgentId).toBe('claude-code')
    await flush()
    expect(result.current.defaultAgentId).toBe('codex')

    act(() => result.current.setDefaultAgentId('gemini'))
    expect(result.current.defaultAgentId).toBe('gemini')
    await flush()
    expect(result.current.defaultAgentId).toBe('gemini')
    expect(mutations).toEqual([
      { path: 'settings.set', input: { key: 'default_agent_id', value: 'gemini' } }
    ])
  })

  it('re-seeds on a fresh mount (dialog reopened)', async () => {
    const first = renderHook(() => useDefaultAgent(), { wrapper })
    await flush()
    act(() => first.result.current.setDefaultAgentId('gemini'))
    first.unmount()

    const { result } = renderHook(() => useDefaultAgent(), { wrapper })
    await flush()
    expect(result.current.defaultAgentId).toBe('codex')
  })

  it('refetches on an out-of-band settings change', async () => {
    const { result } = renderHook(() => useDefaultAgent(), { wrapper })
    await flush()
    storedMode = 'cursor'
    act(() => {
      window.dispatchEvent(new CustomEvent('sz:settings-changed'))
    })
    await flush()
    expect(result.current.defaultAgentId).toBe('cursor')
  })
})
