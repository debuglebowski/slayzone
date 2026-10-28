// @vitest-environment jsdom
// Pins useAgentTurns: lists a worktree's turns, refetches when refreshKey changes (and
// only then, not on every render), refetches on agentTurns.onChanged for the same path
// (trailing slash ignored) but not another path, and never fetches without a path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

let fetches: string[] = []
let turnsByPath: Record<string, Array<{ id: string }>> = {}
let onChanged: ((path: string) => void) | null = null

// One stable proxy, as the tRPC adapter returns.
const trpc = {
  agentTurns: {
    list: {
      queryOptions: (input: { worktreePath: string }, opts: { enabled: boolean }) => ({
        queryKey: ['agentTurns.list', input.worktreePath],
        queryFn: async () => {
          fetches.push(input.worktreePath)
          return turnsByPath[input.worktreePath] ?? []
        },
        ...opts
      })
    },
    onChanged: {
      subscriptionOptions: (_i: unknown, o: { enabled: boolean; onData: (p: string) => void }) => o
    }
  }
}
vi.mock('@slayzone/transport/client', () => ({
  typedTrpc: () => ({ useTRPC: () => trpc }),
  useSubscription: (o: { enabled: boolean; onData: (p: string) => void }) => {
    onChanged = o.enabled ? o.onData : null
  }
}))

const { useAgentTurns } = await import('./useAgentTurns')

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

type P = { path: string | null; refreshKey: number; tick: number }
function setup(initial: Partial<P> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  // `tick` forces a re-render with otherwise identical inputs.
  return renderHook((p: P) => useAgentTurns(p.path, p.refreshKey), {
    wrapper,
    initialProps: { path: '/wt', refreshKey: 0, tick: 0, ...initial }
  })
}

beforeEach(() => {
  fetches = []
  turnsByPath = { '/wt': [{ id: 't1' }] }
  onChanged = null
})
afterEach(cleanup)

describe('useAgentTurns', () => {
  it('returns [] until loaded, then the worktree turns', async () => {
    const { result } = setup()
    expect(result.current).toEqual([])
    await flush()
    expect(result.current).toEqual([{ id: 't1' }])
    expect(fetches).toEqual(['/wt'])
  })

  it('refetches when refreshKey changes, not on a plain re-render', async () => {
    const { result, rerender } = setup()
    await flush()
    rerender({ path: '/wt', refreshKey: 0, tick: 1 })
    await flush()
    expect(fetches).toEqual(['/wt'])

    turnsByPath['/wt'] = [{ id: 't1' }, { id: 't2' }]
    rerender({ path: '/wt', refreshKey: 1, tick: 1 })
    await flush()
    expect(fetches).toEqual(['/wt', '/wt'])
    expect(result.current).toEqual([{ id: 't1' }, { id: 't2' }])
  })

  it('refetches on onChanged for the same path (trailing slash ignored), not another', async () => {
    const { result } = setup()
    await flush()
    act(() => onChanged?.('/wt-other'))
    await flush()
    expect(fetches).toEqual(['/wt'])

    turnsByPath['/wt'] = [{ id: 't3' }]
    act(() => onChanged?.('/wt/'))
    await flush()
    expect(fetches).toEqual(['/wt', '/wt'])
    expect(result.current).toEqual([{ id: 't3' }])
  })

  it('without a path: no fetch, no subscription, refreshKey is a no-op', async () => {
    const { result, rerender } = setup({ path: null })
    await flush()
    rerender({ path: null, refreshKey: 1, tick: 0 })
    await flush()
    expect(fetches).toEqual([])
    expect(onChanged).toBeNull()
    expect(result.current).toEqual([])
  })

  it('follows a path change', async () => {
    turnsByPath['/b'] = [{ id: 'b1' }]
    const { result, rerender } = setup()
    await flush()
    rerender({ path: '/b', refreshKey: 0, tick: 0 })
    await flush()
    expect(result.current).toEqual([{ id: 'b1' }])
    act(() => onChanged?.('/b'))
    await flush()
    expect(fetches).toEqual(['/wt', '/b', '/b'])
  })
})
