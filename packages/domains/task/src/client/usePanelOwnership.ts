import { useCallback, useEffect, useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'

interface OwnershipEntry {
  panelId: string
  ownerWindowId: number
}

/**
 * Subscribes to panel ownership for a given task. Each panel can be "owned" by
 * one window at a time. The owning window renders the panel; other windows
 * show a stub.
 */
export function usePanelOwnership(taskId: string | undefined) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [entries, setEntries] = useState<OwnershipEntry[]>([])
  const [releasedOnClose, setReleasedOnClose] = useState<Array<{
    taskId: string
    panelId: string
  }> | null>(null)

  // Resolve this window's webContents id once
  const windowIdQuery = useQuery(trpc.app.taskWindows.getWindowId.queryOptions())
  const windowId = windowIdQuery.data ?? null

  // Refresh ownership snapshot + subscribe to live changes
  useEffect(() => {
    if (!taskId) {
      setEntries([])
      return
    }
    let alive = true
    trpcClient.app.taskWindows.getOwnership.query({ taskId }).then((list) => {
      if (alive) setEntries(list)
    })
    return () => {
      alive = false
    }
  }, [taskId, trpcClient])

  useSubscription(
    trpc.app.taskWindows.onOwnershipChanged.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: (payload) => {
        if (payload.taskId === taskId) setEntries(payload.ownership)
      }
    })
  )

  // Listen for window-close releases so the owning window's renderer can react
  useSubscription(
    trpc.app.taskWindows.onPanelsReleasedOnClose.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: (payload) => {
        if (!taskId) return
        const forThisTask = payload.released.filter((r) => r.taskId === taskId)
        if (forThisTask.length > 0) setReleasedOnClose(forThisTask)
      }
    })
  )

  const ownerOf = useCallback(
    (panelId: string): number | null =>
      entries.find((e) => e.panelId === panelId)?.ownerWindowId ?? null,
    [entries]
  )

  const isOwnedByMe = useCallback(
    (panelId: string): boolean => {
      if (windowId == null) return false
      return ownerOf(panelId) === windowId
    },
    [windowId, ownerOf]
  )

  const hasOtherOwner = useCallback(
    (panelId: string): boolean => {
      const owner = ownerOf(panelId)
      return owner !== null && owner !== windowId
    },
    [windowId, ownerOf]
  )

  const claim = useCallback(
    async (panelId: string) => {
      if (!taskId) return { ok: false }
      return trpcClient.app.taskWindows.claimPanel.mutate({ taskId, panelId })
    },
    [taskId, trpcClient]
  )

  const claimAndCloseOther = useCallback(
    async (panelId: string) => {
      if (!taskId) return { ok: false }
      return trpcClient.app.taskWindows.claimAndCloseOther.mutate({ taskId, panelId })
    },
    [taskId, trpcClient]
  )

  const release = useCallback(
    async (panelId: string) => {
      if (!taskId) return { ok: false }
      return trpcClient.app.taskWindows.releasePanel.mutate({ taskId, panelId })
    },
    [taskId, trpcClient]
  )

  const consumeReleasedOnClose = useCallback(() => {
    setReleasedOnClose(null)
  }, [])

  return useMemo(
    () => ({
      windowId,
      ownerOf,
      isOwnedByMe,
      hasOtherOwner,
      claim,
      claimAndCloseOther,
      release,
      releasedOnClose,
      consumeReleasedOnClose
    }),
    [
      windowId,
      ownerOf,
      isOwnedByMe,
      hasOtherOwner,
      claim,
      claimAndCloseOther,
      release,
      releasedOnClose,
      consumeReleasedOnClose
    ]
  )
}
