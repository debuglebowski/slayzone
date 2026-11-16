/**
 * FU5 (computer stalls, request fan-out): a sessions list re-read on EVERY change
 * notice — its task's prompts and its sessions both announce one change, and every
 * mounted list instance called `refetch()` (which cancels and re-sends). One change
 * is now one re-read per query, however many notices and instances saw it.
 */
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { invalidateSoon } from './coalesced-invalidate'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('notices of one query within the window are one invalidation', () => {
  const client = new QueryClient()
  const spy = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
  const key = ['agentSessions', 'list', { taskId: 't', agentId: 'claude-code' }]
  // Two mounted lists × (prompts changed + sessions changed).
  for (let i = 0; i < 4; i++) invalidateSoon(client, [...key])
  expect(spy).not.toHaveBeenCalled()
  vi.advanceTimersByTime(50)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith({ queryKey: key, exact: true })
})

test('other queries, other clients and later windows are separate', () => {
  const a = new QueryClient()
  const b = new QueryClient()
  const spyA = vi.spyOn(a, 'invalidateQueries').mockResolvedValue()
  const spyB = vi.spyOn(b, 'invalidateQueries').mockResolvedValue()
  invalidateSoon(a, ['x', 1])
  invalidateSoon(a, ['x', 2])
  invalidateSoon(b, ['x', 1])
  vi.advanceTimersByTime(50)
  expect(spyA).toHaveBeenCalledTimes(2)
  expect(spyB).toHaveBeenCalledTimes(1)
  invalidateSoon(a, ['x', 1])
  vi.advanceTimersByTime(50)
  expect(spyA).toHaveBeenCalledTimes(3)
})
