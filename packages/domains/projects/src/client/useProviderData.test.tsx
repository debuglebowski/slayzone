// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

type Opts = { proc: string; input: { connectionId: string; groupId?: string }; enabled: boolean }

/** Loaded query results by key; a missing key = still loading. Stable identities. */
let loaded: Record<string, unknown[]> = {}
const keyOf = ({ proc, input }: Opts) => `${proc}:${input.connectionId}:${input.groupId ?? ''}`

vi.mock('@slayzone/transport/client', () => {
  const procedure = (proc: string) => ({
    queryOptions: (input: Opts['input'], opts: { enabled: boolean }) => ({
      proc,
      input,
      enabled: opts.enabled
    })
  })
  const trpc = {
    integrations: {
      listProviderGroups: procedure('groups'),
      listProviderScopes: procedure('scopes')
    }
  }
  return { useTRPC: () => trpc }
})

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: Opts) => {
    const data = opts.enabled ? loaded[keyOf(opts)] : undefined
    return {
      data,
      isSuccess: data !== undefined,
      isFetching: opts.enabled && data === undefined,
      error: null,
      refetch: vi.fn()
    }
  }
}))

import { useProviderData } from './useProviderData'

const G = [{ id: 'g1' }, { id: 'g2' }]
const S1 = [{ id: 's1' }, { id: 's2' }]
const S2 = [{ id: 's3' }]

type Props = {
  connectionId: string | null
  options?: { initialGroupId?: string | null; initialScopeId?: string | null }
}
const setup = (initial: Props) =>
  renderHook(({ connectionId, options }: Props) => useProviderData(connectionId, options), {
    initialProps: initial
  })

beforeEach(() => {
  loaded = {
    'groups:c1:': G,
    'scopes:c1:g1': S1,
    'scopes:c1:g2': S2
  }
})

describe('useProviderData selection', () => {
  it('auto-selects the first group and scope once they load', () => {
    const { result } = setup({ connectionId: 'c1' })
    expect(result.current.selectedGroupId).toBe('g1')
    expect(result.current.selectedScopeId).toBe('s1')
    expect(result.current.groups).toBe(G)
    expect(result.current.scopes).toBe(S1)
  })

  it('prefers the initial ids when they exist', () => {
    const { result } = setup({
      connectionId: 'c1',
      options: { initialGroupId: 'g2', initialScopeId: 's3' }
    })
    expect(result.current.selectedGroupId).toBe('g2')
    expect(result.current.selectedScopeId).toBe('s3')
  })

  it('selects as data arrives, keeping a still-valid manual choice', () => {
    loaded = {}
    const { result, rerender } = setup({ connectionId: 'c1' })
    expect(result.current.selectedGroupId).toBeNull()

    loaded = { 'groups:c1:': G }
    rerender({ connectionId: 'c1' })
    expect(result.current.selectedGroupId).toBe('g1')
    expect(result.current.selectedScopeId).toBeNull()

    act(() => result.current.setSelectedGroupId('g2'))
    loaded = { 'groups:c1:': [...G], 'scopes:c1:g2': S2 }
    rerender({ connectionId: 'c1' })
    expect(result.current.selectedGroupId).toBe('g2')
    expect(result.current.selectedScopeId).toBe('s3')
  })

  it('clears both selections when the connection clears', () => {
    const { result, rerender } = setup({ connectionId: 'c1' })
    expect(result.current.selectedScopeId).toBe('s1')

    rerender({ connectionId: null })
    expect(result.current.selectedGroupId).toBeNull()
    expect(result.current.selectedScopeId).toBeNull()
    expect(result.current.groups).toEqual([])
  })

  it('without a connection, initial ids are dropped on mount', () => {
    const { result } = setup({
      connectionId: null,
      options: { initialGroupId: 'g1', initialScopeId: 's1' }
    })
    expect(result.current.selectedGroupId).toBeNull()
    expect(result.current.selectedScopeId).toBeNull()
  })

  it('clearing the group clears the scope', () => {
    const { result } = setup({ connectionId: 'c1' })
    expect(result.current.selectedScopeId).toBe('s1')
    act(() => result.current.setSelectedGroupId(null))
    expect(result.current.selectedScopeId).toBeNull()
  })
})
