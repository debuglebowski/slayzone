// @vitest-environment jsdom
// Every window — the main window AND a popped-out task window — seeds the hub registry
// at boot, so "is this hub local?" (local agents' file:, the camera button, the
// cookie jar) never reads the desktop's own hub as remote in a task window.
import { afterEach, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { seedHubRegistry, useHubRegistryStore } from '@slayzone/transport/client'
import { useBrowserPartition, useHubIsLocal } from './useHubIsLocal'

const bootstrap = (registry: {
  hubs: Array<{ id: string; kind: 'local' | 'remote'; label: string; url?: string }>
  defaultHubId: string
}) => ({
  getHubRegistry: async () => registry,
  getHubTokens: async () => ({})
})

afterEach(() => useHubRegistryStore.getState().seed([], 'local', {}))

it('unseeded (the bug): the local hub reads as remote', () => {
  const { result } = renderHook(() => useHubIsLocal())
  expect(result.current).toBe(false)
})

it('a task-window boot seeds it: the local hub is local, its jar is persist:browser-tabs', async () => {
  await seedHubRegistry(
    { url: 'ws://127.0.0.1:51100/trpc' },
    bootstrap({
      hubs: [{ id: 'local', kind: 'local', label: 'This computer' }],
      defaultHubId: 'local'
    })
  )
  const local = renderHook(() => useHubIsLocal())
  expect(local.result.current).toBe(true)
  const jar = renderHook(() => useBrowserPartition())
  expect(jar.result.current).toBe('persist:browser-tabs')
})

it('a window whose default hub is remote gets that hub’s own jar', async () => {
  await seedHubRegistry(
    { url: 'wss://hub.example.com/trpc' },
    bootstrap({
      hubs: [{ id: 'hub:https://hub.example.com', kind: 'remote', label: 'Team', url: 'wss://x' }],
      defaultHubId: 'hub:https://hub.example.com'
    })
  )
  expect(renderHook(() => useHubIsLocal()).result.current).toBe(false)
  expect(renderHook(() => useBrowserPartition()).result.current).toMatch(
    /^persist:browser-tabs-hub-[0-9a-f]{8}/
  )
})
