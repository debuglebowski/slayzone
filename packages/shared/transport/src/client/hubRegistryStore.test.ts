import { beforeEach, describe, expect, it } from 'vitest'
import { useHubRegistryStore } from './hubRegistryStore'

const LOCAL = { id: 'local', kind: 'local' as const, label: 'Local', url: 'ws://127.0.0.1:1/trpc' }
const REMOTE_A = { id: 'remote-a', kind: 'remote' as const, label: 'A', url: 'wss://a.example/trpc' }
const REMOTE_B = { id: 'remote-b', kind: 'remote' as const, label: 'B', url: 'wss://b.example/trpc' }

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

  it('addHubs appends without disturbing existing entries (the live-add path)', () => {
    useHubRegistryStore.getState().seed([LOCAL], 'local', {})
    useHubRegistryStore.getState().addHubs([REMOTE_A])
    expect(useHubRegistryStore.getState().hubs).toEqual([LOCAL, REMOTE_A])
    // Default (local) entry — and its url pin from main.tsx — must be untouched.
    expect(useHubRegistryStore.getState().hubs[0]).toBe(LOCAL)
  })

  it('addHubs is idempotent by id — re-adding an existing hub id is a no-op', () => {
    useHubRegistryStore.getState().seed([LOCAL, REMOTE_A], 'local', {})
    useHubRegistryStore.getState().addHubs([{ ...REMOTE_A, label: 'A (renamed)' }])
    expect(useHubRegistryStore.getState().hubs).toEqual([LOCAL, REMOTE_A])
  })

  it('addHubs can add multiple hubs in one call, skipping only the duplicates', () => {
    useHubRegistryStore.getState().seed([LOCAL, REMOTE_A], 'local', {})
    useHubRegistryStore.getState().addHubs([REMOTE_A, REMOTE_B])
    expect(useHubRegistryStore.getState().hubs).toEqual([LOCAL, REMOTE_A, REMOTE_B])
  })

  it('setTokens replaces the token map wholesale (the sign-in path)', () => {
    useHubRegistryStore.getState().seed([LOCAL, REMOTE_A], 'local', { 'remote-a': 'old' })
    useHubRegistryStore.getState().setTokens({ 'remote-a': 'new', 'remote-b': 'tok-b' })
    expect(useHubRegistryStore.getState().tokens).toEqual({ 'remote-a': 'new', 'remote-b': 'tok-b' })
  })
})
