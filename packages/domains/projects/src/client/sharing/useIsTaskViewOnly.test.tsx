// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useIsTaskViewOnly } from './useSharing'

// Every board card, list row and task context menu reads its own view-only flag
// (hundreds mounted at once). The board's role cache changes rarely; every other query
// changes all the time (each agent event, each board patch) — so a reader must not do
// work per unrelated cache event.

const ROLES_KEY = [['sharing', 'boardRoles']]

function setup() {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

const listenerCount = (qc: QueryClient) =>
  (qc.getQueryCache() as unknown as { listeners: Set<unknown> }).listeners.size

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('reads the task role from the board role cache and follows its changes', () => {
  const { queryClient, wrapper } = setup()
  queryClient.setQueryData(ROLES_KEY, { 'task:a': 'view', 'task:b': 'edit' })
  const a = renderHook(() => useIsTaskViewOnly('a'), { wrapper })
  const b = renderHook(() => useIsTaskViewOnly('b'), { wrapper })
  expect(a.result.current).toBe(true)
  expect(b.result.current).toBe(false)

  act(() => queryClient.setQueryData(ROLES_KEY, { 'task:a': 'edit', 'task:b': 'view' }))
  expect(a.result.current).toBe(false)
  expect(b.result.current).toBe(true)

  act(() => queryClient.removeQueries({ queryKey: ROLES_KEY }))
  expect(b.result.current).toBe(false)
})

it('roles that land after the reader mounted are picked up', () => {
  const { queryClient, wrapper } = setup()
  const a = renderHook(() => useIsTaskViewOnly('a'), { wrapper })
  expect(a.result.current).toBe(false)
  act(() => queryClient.setQueryData(ROLES_KEY, { 'task:a': 'view' }))
  expect(a.result.current).toBe(true)
})

it('many readers share one query-cache listener', () => {
  const { queryClient, wrapper } = setup()
  const before = listenerCount(queryClient)
  const readers = Array.from({ length: 50 }, (_, i) =>
    renderHook(() => useIsTaskViewOnly(`t${i}`), { wrapper })
  )
  expect(listenerCount(queryClient) - before).toBeLessThanOrEqual(1)
  for (const r of readers) r.unmount()
  expect(listenerCount(queryClient)).toBe(before)
})

it('an unrelated query update reads nothing from the cache', () => {
  const { queryClient, wrapper } = setup()
  queryClient.setQueryData(ROLES_KEY, { 'task:a': 'view' })
  for (let i = 0; i < 20; i++) renderHook(() => useIsTaskViewOnly(`t${i}`), { wrapper })
  const cache = queryClient.getQueryCache()
  const find = vi.spyOn(cache, 'find')
  const get = vi.spyOn(cache, 'get')
  act(() => queryClient.setQueryData([['task', 'loadBoardData']], { tasks: [] }))
  const lookups = find.mock.calls.length + get.mock.calls.length
  // setQueryData itself looks the board query up once; readers add nothing.
  expect(lookups).toBeLessThanOrEqual(2)
})
