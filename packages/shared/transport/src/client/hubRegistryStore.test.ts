import { beforeEach, describe, expect, it } from 'vitest'
import { useHubRegistryStore } from './hubRegistryStore'

const LOCAL = { id: 'local', kind: 'local' as const, label: 'Local', url: 'ws://127.0.0.1:1/trpc' }
const REMOTE_A = {
  id: 'remote-a',
  kind: 'remote' as const,
  label: 'A',
  url: 'wss://a.example/trpc'
}

describe('hubRegistryStore', () => {
  beforeEach(() => {
    useHubRegistryStore.setState({ hubs: [], defaultHubId: 'local', tokens: {} })
  })

  it('seed replaces the whole registry (the boot path)', () => {
    useHubRegistryStore.getState().seed([LOCAL], 'local', {})
    expect(useHubRegistryStore.getState().hubs).toEqual([LOCAL])
    expect(useHubRegistryStore.getState().defaultHubId).toBe('local')

    useHubRegistryStore.getState().seed([LOCAL, REMOTE_A], 'local', { 'remote-a': 'tok' })
    expect(useHubRegistryStore.getState().hubs).toEqual([LOCAL, REMOTE_A])
    expect(useHubRegistryStore.getState().tokens).toEqual({ 'remote-a': 'tok' })
  })

  it('setTokens replaces the token map wholesale (the sign-in path)', () => {
    useHubRegistryStore.getState().seed([LOCAL, REMOTE_A], 'local', { 'remote-a': 'old' })
    useHubRegistryStore.getState().setTokens({ 'remote-a': 'new', 'remote-b': 'tok-b' })
    expect(useHubRegistryStore.getState().tokens).toEqual({
      'remote-a': 'new',
      'remote-b': 'tok-b'
    })
  })
})
