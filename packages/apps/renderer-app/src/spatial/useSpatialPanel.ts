import { useEffect, useState } from 'react'
import type { SpatialTaskPanel } from './spatial-route'

interface PanelLocks {
  detached: string
  mounted: string
}

function panelLocks(taskId: string, panel: SpatialTaskPanel): PanelLocks {
  // The PTY belongs to the task. Groups on the same hub share that PTY.
  const key = `slayzone-spatial:${taskId}:${panel}`
  return { detached: `${key}:detached`, mounted: `${key}:mounted` }
}

export function supportsSpatialHandoff(): boolean {
  return typeof navigator.locks !== 'undefined' && typeof BroadcastChannel !== 'undefined'
}

function notifyDetached(name: string): void {
  const channel = new BroadcastChannel(name)
  channel.postMessage(null)
  channel.close()
}

function useLock(
  name: string | null,
  onError: () => void,
  onAcquire?: (name: string) => void
): boolean {
  const [held, setHeld] = useState<{ name: string } | null>(null)

  useEffect(() => {
    if (!name) return
    const lease = { name }
    const controller = new AbortController()
    let release: (() => void) | undefined
    void navigator.locks
      .request(name, { signal: controller.signal }, async () => {
        if (controller.signal.aborted) return
        const released = new Promise<void>((resolve) => {
          release = resolve
        })
        setHeld(lease)
        onAcquire?.(name)
        await released
      })
      .catch(() => {
        if (!controller.signal.aborted) onError()
      })
      .finally(() => setHeld((current) => (current === lease ? null : current)))

    // The previous render removes the panel before effect cleanup releases this lock.
    // Closing a WebView also releases its locks, even without a JS unload event.
    return () => {
      controller.abort()
      release?.()
    }
  }, [name, onAcquire, onError])

  return name !== null && held?.name === name
}

function useDetachedWindow(name: string | null, onError: () => void): boolean | null {
  const [snapshot, setSnapshot] = useState<{ name: string; detached: boolean } | null>(null)

  useEffect(() => {
    if (!name) return
    const controller = new AbortController()
    const channel = new BroadcastChannel(name)
    let pending = false
    let revision = 0
    const reportError = (): void => {
      if (!controller.signal.aborted) onError()
    }

    const refresh = async (): Promise<void> => {
      const request = ++revision
      try {
        const { held } = await navigator.locks.query()
        if (controller.signal.aborted || request !== revision) return
        const detached =
          held?.some((lock) => lock.name === name && lock.mode === 'exclusive') ?? false
        setSnapshot((prev) =>
          prev?.name === name && prev.detached === detached ? prev : { name, detached }
        )
        if (!detached || pending) return
        // This observer runs when the detached document releases the lease, including
        // when the host closes it or the web process exits without sending a message.
        pending = true
        void navigator.locks
          .request(name, { mode: 'shared', signal: controller.signal }, () => {
            pending = false
            void refresh()
          })
          .catch(reportError)
      } catch {
        reportError()
      }
    }

    channel.onmessage = () => void refresh()
    void refresh()
    return () => {
      controller.abort()
      channel.close()
    }
  }, [name, onError])

  return snapshot?.name === name ? snapshot.detached : null
}

export function useSpatialPanel(
  taskId: string,
  panel: SpatialTaskPanel,
  mode: 'docked' | 'detached' | 'inactive',
  onError: () => void
): boolean {
  const supported = supportsSpatialHandoff()
  const locks = panelLocks(taskId, panel)
  const detached = useDetachedWindow(
    supported && mode === 'docked' ? locks.detached : null,
    onError
  )
  const requested = useLock(
    supported && mode === 'detached' ? locks.detached : null,
    onError,
    notifyDetached
  )
  const shouldMount = mode === 'docked' ? detached === false : requested
  const mounted = useLock(supported && shouldMount ? locks.mounted : null, onError)
  return supported ? shouldMount && mounted : mode === 'docked'
}
