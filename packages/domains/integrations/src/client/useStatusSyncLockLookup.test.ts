import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

vi.mock('./trpc', () => ({ useTRPC: vi.fn() }))

import { fetchStatusSyncLock } from './useStatusSyncLockLookup'

// Per-project, per-provider mapping the lock check reads.
let mappings: Record<string, { status_setup_complete?: boolean } | null> = {}
let fetchFails = false

const fetchQuery = vi.fn((opts: { input: { projectId: string; provider: string } }) =>
  fetchFails
    ? Promise.reject(new Error('offline'))
    : Promise.resolve(mappings[`${opts.input.projectId}:${opts.input.provider}`] ?? null)
)
const queryClient = { fetchQuery } as unknown as QueryClient
const trpc = {
  integrations: {
    getProjectMapping: { queryOptions: (input: unknown) => ({ input }) }
  }
} as unknown as Parameters<typeof fetchStatusSyncLock>[1]

beforeEach(() => {
  mappings = {}
  fetchFails = false
  fetchQuery.mockClear()
})

describe('fetchStatusSyncLock', () => {
  it('reports the provider whose status sync is set up', async () => {
    mappings = { 'p1:github': { status_setup_complete: true } }
    expect(await fetchStatusSyncLock(queryClient, trpc, 'p1')).toBe('GitHub')
  })

  it('prefers Linear when both are set up', async () => {
    mappings = {
      'p1:linear': { status_setup_complete: true },
      'p1:github': { status_setup_complete: true }
    }
    expect(await fetchStatusSyncLock(queryClient, trpc, 'p1')).toBe('Linear')
  })

  it('reads both providers of the given project', async () => {
    await fetchStatusSyncLock(queryClient, trpc, 'p2')
    expect(fetchQuery).toHaveBeenCalledWith({ input: { projectId: 'p2', provider: 'linear' } })
    expect(fetchQuery).toHaveBeenCalledWith({ input: { projectId: 'p2', provider: 'github' } })
  })

  it('is null when neither is set up', async () => {
    mappings = { 'p1:linear': { status_setup_complete: false } }
    expect(await fetchStatusSyncLock(queryClient, trpc, 'p1')).toBeNull()
  })

  it('treats a failed lookup as unlocked', async () => {
    fetchFails = true
    expect(await fetchStatusSyncLock(queryClient, trpc, 'p1')).toBeNull()
  })
})
