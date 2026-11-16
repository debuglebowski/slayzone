import { useState } from 'react'
import { useSubscription } from '@slayzone/transport/client'
import { useStableCallback } from '@slayzone/ui'
import { useTRPC, useTRPCClient } from './trpc'

/** The not-attached overlay's actual subscription and action callbacks. */
export function useUnattachedSession(
  sessionId: string,
  showNotAttached: boolean,
  remountPane?: () => void
) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [unattachedHere, setUnattachedHere] = useState<{ computerId: string } | null>(null)
  const [attaching, setAttaching] = useState(false)
  useSubscription(
    trpc.pty.onUnattachedChange.subscriptionOptions(undefined, {
      enabled: showNotAttached,
      onData: (list) => {
        const here = list.find((s) => s.sessionId === sessionId && s.status === 'unattached')
        setUnattachedHere(here ? { computerId: here.computerId } : null)
      }
    })
  )
  const handleNotAttachedRestart = useStableCallback(() => {
    // An explicit restart: the session still running from before ends first —
    // otherwise the new start would take it over instead of restarting.
    // A false result still acknowledges replacement intent. An RPC rejection
    // does not: keep the overlay so a retry cannot silently adopt the old agent.
    void trpcClient.pty.kill.mutate({ sessionId }).then(
      () => remountPane?.(),
      () => undefined
    )
  })
  const handleNotAttachedAttach = useStableCallback(() => {
    if (!unattachedHere) return
    setAttaching(true)
    void trpcClient.pty.unattachedAttach
      .mutate({ computerId: unattachedHere.computerId, sessionId })
      .then(
        (result) => {
          setAttaching(false)
          // Attached: remount to show it (scrollback replayed from its computer).
          if (result.ok) remountPane?.()
        },
        () => setAttaching(false)
      )
  })

  return { unattachedHere, attaching, handleNotAttachedRestart, handleNotAttachedAttach }
}
