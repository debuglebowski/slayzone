import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from './trpc'
import { useStableCallback } from '@slayzone/ui'
import { holdTaskPaneEvent, isTaskPaneLive, type TaskPaneEvent } from './taskPaneEvents'

export interface TaskPaneEventCatcherProps {
  /** Is `taskId` an open tab of this window? Events for other tasks are not ours. */
  isOpenTask: (taskId: string) => boolean
  /** Mount the tab's page now (it has an event waiting). */
  onWake: (taskId: string) => void
}

/**
 * Listens, for one hub, on behalf of open tabs whose detail page is not mounted
 * yet (see taskPaneEvents.ts). Render one per hub, inside that hub's HubScope.
 * Renders nothing.
 */
export function TaskPaneEventCatcher({ isOpenTask, onWake }: TaskPaneEventCatcherProps): null {
  const trpc = useTRPC()

  const catchEvent = useStableCallback((event: TaskPaneEvent | null, taskId: string): void => {
    if (isTaskPaneLive(taskId) || !isOpenTask(taskId)) return
    if (event) holdTaskPaneEvent(event)
    onWake(taskId)
  })

  useSubscription(
    trpc.menu.onBrowserEnsurePanelOpen.subscriptionOptions(undefined, {
      onData: (payload) =>
        catchEvent({ kind: 'browser-ensure-panel-open', payload }, payload.taskId)
    })
  )
  useSubscription(
    trpc.menu.onBrowserCreateTab.subscriptionOptions(undefined, {
      onData: (payload) => catchEvent({ kind: 'browser-create-tab', payload }, payload.taskId)
    })
  )
  useSubscription(
    trpc.menu.onOpenArtifact.subscriptionOptions(undefined, {
      onData: (payload) => catchEvent({ kind: 'open-artifact', payload }, payload.taskId)
    })
  )
  useSubscription(
    trpc.pty.onRespawnSuggested.subscriptionOptions(undefined, {
      onData: (payload) =>
        catchEvent(
          { kind: 'respawn-suggested', payload: { taskId: payload.taskId } },
          payload.taskId
        )
    })
  )
  // Ensure-alive (`slay pty start`, `slay tasks open --start`) is re-broadcast
  // until a page acks it, so waking the tab is enough — no need to hold it.
  useSubscription(
    trpc.pty.onEnsureAlive.subscriptionOptions(undefined, {
      onData: (payload) => catchEvent(null, payload.taskId)
    })
  )
  return null
}
