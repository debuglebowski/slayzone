import { useHubId, useHubRegistryStore } from '@slayzone/transport/client'
import { browserPartitionForHub } from '../shared'

/**
 * Whether the hub this subtree talks to is THIS device's own local hub (`kind:
 * 'local'` in the window's hub registry). Every window seeds that registry at boot —
 * the main window and task windows alike (`seedHubRegistry`) — so this never reads a
 * local hub as remote.
 */
export function useHubIsLocal(): boolean {
  const hubId = useHubId()
  return useHubRegistryStore((s) => {
    const id = hubId ?? s.defaultHubId
    return s.hubs.some((h) => h.id === id && h.kind === 'local')
  })
}

/** The cookie jar this subtree's browser views use (see `browserPartitionForHub`). */
export function useBrowserPartition(): string {
  const hubId = useHubId()
  const defaultHubId = useHubRegistryStore((s) => s.defaultHubId)
  return browserPartitionForHub(hubId ?? defaultHubId, useHubIsLocal())
}
