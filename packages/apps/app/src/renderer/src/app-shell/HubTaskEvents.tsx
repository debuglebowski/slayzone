import { HubScope, useFederationOrNull, useSubscription } from '@slayzone/transport/client'
import { useStableCallback } from '@slayzone/ui'
import { useTabStore } from '@slayzone/tabs-state'
import { useTRPC, useTRPCClient } from '../trpc'

export interface HubTaskEventsProps {
  /** Open a task tab and focus it. */
  openTask: (taskId: string) => void
  /** Open a task tab without switching to it. */
  openTaskInBackground: (taskId: string) => void
  guardTaskOpen: (taskId: string, fn: (id: string) => void) => void
}

/**
 * Task open/close requests a hub raises about its own tasks (`slay tasks open`,
 * `slay tasks done --close`, an agent starting a terminal…). Each hub emits them on
 * its own bus, so the window listens on EVERY hub it is signed in to — listening on
 * the local hub only, a remote task's `slay tasks open` reached no one.
 */
export function HubTaskEvents(props: HubTaskEventsProps): React.JSX.Element {
  const fed = useFederationOrNull()
  // No federation (single-client boot): the ambient client is the only hub.
  if (!fed) return <HubTaskEventsListener {...props} />
  return (
    <>
      {fed.hubs.map((hub) => (
        <HubScope key={hub.id} hubId={hub.id}>
          <HubTaskEventsListener {...props} />
        </HubScope>
      ))}
    </>
  )
}

/** One hub's listener; renders nothing. Runs inside that hub's HubScope. */
function HubTaskEventsListener({
  openTask,
  openTaskInBackground,
  guardTaskOpen
}: HubTaskEventsProps): null {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()

  const onOpen = useStableCallback(
    ({ taskId, background, raise }: { taskId: string; background?: boolean; raise?: boolean }) => {
      if (background) guardTaskOpen(taskId, openTaskInBackground)
      else openTask(taskId)
      // The hub asked for the window too; only the desktop can raise it (a host
      // procedure — forwarded to the local hub from a remote one).
      if (raise) void trpcClient.app.window.raise.mutate().catch(() => undefined)
    }
  )
  const onClose = useStableCallback((taskId: string) => {
    useTabStore.getState().closeTabByTaskId(taskId)
    void trpcClient.processes.removeForTask.mutate({ taskId })
  })

  useSubscription(trpc.menu.onOpenTask.subscriptionOptions(undefined, { onData: onOpen }))
  useSubscription(trpc.menu.onCloseTask.subscriptionOptions(undefined, { onData: onClose }))
  return null
}
