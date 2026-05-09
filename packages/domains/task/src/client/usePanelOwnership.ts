import { useCallback, useEffect, useState, useMemo } from 'react'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'

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
  const [windowId, setWindowId] = useState<number | null>(null)
  const [entries, setEntries] = useState<OwnershipEntry[]>([])
  const [releasedOnClose, setReleasedOnClose] = useState<Array<{ taskId: string; panelId: string }> | null>(null)

  // Resolve this window's id once via tRPC (server reads ?windowId from WS query)
  useEffect(() => {
    let alive = true
    trpcClient.app.taskWindows.getWindowId.query().then((id) => {
      if (alive) setWindowId(id as number | null)
    })
    return () => { alive = false }
  }, [trpcClient])

  // Initial ownership snapshot for this task. Resets when taskId changes.
  useEffect(() => {
    if (!taskId) {
      setEntries([])
      return
    }
    let alive = true
    trpcClient.app.taskWindows.getOwnership.query({ taskId }).then((list) => {
      if (alive) setEntries(list as OwnershipEntry[])
    })
    return () => { alive = false }
  }, [taskId, trpcClient])

  useSubscription(
    trpc.app.taskWindows.onOwnershipChanged.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: (payload) => {
        if (payload.taskId === taskId) setEntries(payload.ownership)
      },
    }),
  )

  useSubscription(
    trpc.app.taskWindows.onPanelsReleasedOnClose.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: (payload) => {
        if (!taskId) return
        const forThisTask = payload.released.filter((r) => r.taskId === taskId)
        if (forThisTask.length > 0) setReleasedOnClose(forThisTask)
      },
    }),
  )

  const ownerOf = useCallback(
    (panelId: string): number | null => entries.find((e) => e.panelId === panelId)?.ownerWindowId ?? null,
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
    [windowId, ownerOf, isOwnedByMe, hasOtherOwner, claim, claimAndCloseOther, release, releasedOnClose, consumeReleasedOnClose]
  )
}
