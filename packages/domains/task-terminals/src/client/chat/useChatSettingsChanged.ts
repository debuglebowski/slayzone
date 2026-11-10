import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from '../trpc'

/**
 * Calls `onChanged` when the task's chat settings change outside this client's own
 * write — the hub's saved settings of a restored chat landed on its computer after
 * the chat opened. The settings hooks re-read then, so the pills never show
 * defaults until a reload.
 */
export function useChatSettingsChanged(taskId: string, onChanged: () => void): void {
  const trpc = useTRPC()
  useSubscription(
    trpc.chat.settings.onChanged.subscriptionOptions({ taskId }, { onData: () => onChanged() })
  )
}
