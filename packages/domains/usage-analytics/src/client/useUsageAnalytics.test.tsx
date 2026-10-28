// @vitest-environment jsdom
// Pins useUsageAnalytics' provider filter: it starts on the user's default agent once
// the enabled modes and the default load (never drawing "All" in between), follows the
// default until the user picks one themselves, falls back to "All" when the default is
// not an enabled agent, and filters the analytics to the selected provider.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ALL_PROVIDERS } from '../shared/types'

type Mode = { id: string; label: string; enabled: boolean }
let modes: Mode[] = []
let defaultMode: string | null = null
// When set, the modes list answers only once this resolves.
let modesGate: Promise<void> | null = null

const summary = {
  totalInputTokens: 30,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalSessions: 3,
  cacheHitPercent: 0,
  byProvider: [
    {
      provider: 'claude-code',
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessions: 1
    },
    {
      provider: 'codex',
      inputTokens: 20,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessions: 2
    }
  ],
  byModel: [],
  byDay: [],
  byTask: []
}

// One stable tRPC-react-query-shaped proxy.
const trpc = {
  pty: {
    modesList: {
      queryOptions: () => ({
        queryKey: ['modes'],
        queryFn: async () => {
          if (modesGate) await modesGate
          return modes
        }
      })
    }
  },
  settings: {
    get: {
      queryOptions: (input: { key: string }) => ({
        queryKey: ['settings.get', input.key],
        queryFn: async () => defaultMode
      })
    }
  },
  usageAnalytics: {
    query: {
      queryOptions: (range: string, opts?: { enabled?: boolean }) => ({
        queryKey: ['usage', range],
        queryFn: async () => summary,
        ...opts
      }),
      queryKey: (range: string) => ['usage', range]
    },
    refresh: {
      mutationOptions: (opts: object) => ({ mutationFn: async () => summary, ...opts })
    }
  }
}
vi.mock('@slayzone/transport/client', () => ({ useTRPC: () => trpc }))

const { useUsageAnalytics } = await import('./useUsageAnalytics')

let queryClient: QueryClient
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

// Queries settle in a chain (modes + default → analytics), so give each a macrotask.
async function flush(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

// Every render the page would draw, as [provider options shown, selected provider].
function setup() {
  const seen: Array<[number, string]> = []
  const hook = renderHook(
    () => {
      const r = useUsageAnalytics()
      seen.push([r.providerOptions.length, r.selectedProvider])
      return r
    },
    { wrapper }
  )
  return { ...hook, seen }
}

const enabled = (...ids: string[]): Mode[] => ids.map((id) => ({ id, label: id, enabled: true }))

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  modes = [...enabled('claude-code', 'codex'), { id: 'terminal', label: 'T', enabled: true }]
  defaultMode = 'codex'
  modesGate = null
})
afterEach(() => cleanup())

describe('useUsageAnalytics provider filter', () => {
  it('selects the default agent once settings load, and filters to it', async () => {
    const { result } = setup()
    await flush()
    expect(result.current.providerOptions.map((o) => o.id)).toEqual(['claude-code', 'codex'])
    expect(result.current.selectedProvider).toBe('codex')
    expect(result.current.data.totalInputTokens).toBe(20)
  })

  it('never draws "All" once the options and default are known', async () => {
    let open!: () => void
    modesGate = new Promise<void>((r) => {
      open = r
    })
    const { result, seen } = setup()
    await flush() // the default has loaded; the modes list is still out
    expect(result.current.providerOptions).toEqual([])
    await act(async () => open())
    await flush()
    expect(result.current.selectedProvider).toBe('codex')
    expect(seen.filter(([n, sel]) => n > 0 && sel === ALL_PROVIDERS)).toEqual([])
  })

  it('stays on "All" when the default is not an enabled agent', async () => {
    defaultMode = 'gemini'
    const { result } = setup()
    await flush()
    expect(result.current.selectedProvider).toBe(ALL_PROVIDERS)
    expect(result.current.data.totalInputTokens).toBe(30)
  })

  it('a provider the user picks sticks, also when the default changes', async () => {
    const { result } = setup()
    await flush()
    act(() => result.current.setSelectedProvider('claude-code'))
    expect(result.current.selectedProvider).toBe('claude-code')
    defaultMode = 'codex'
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await flush()
    expect(result.current.selectedProvider).toBe('claude-code')
    act(() => result.current.setSelectedProvider(ALL_PROVIDERS))
    expect(result.current.selectedProvider).toBe(ALL_PROVIDERS)
  })

  // Behaviour change (approved): until the user picks, the filter follows the default.
  it('follows a changed default, and falls back to "All" when it is disabled', async () => {
    const { result } = setup()
    await flush()
    expect(result.current.selectedProvider).toBe('codex')
    defaultMode = 'claude-code'
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await flush()
    expect(result.current.selectedProvider).toBe('claude-code')
    modes = enabled('codex')
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await flush()
    expect(result.current.selectedProvider).toBe(ALL_PROVIDERS)
  })
})
