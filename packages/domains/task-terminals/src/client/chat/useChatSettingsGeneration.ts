import { useState } from 'react'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from '../trpc'

/**
 * Counts changes of the task's chat settings made outside this client's own
 * write — the hub's saved settings of a restored chat landed on its computer
 * after the chat opened. The settings hooks re-read when it moves, so the pills
 * never show defaults until a reload.
 *
 * One subscription per chat panel, not one per pill: a change then re-reads all
 * five pills in the same commit, which `readChatInfo` turns into one request.
 */
export function useChatSettingsGeneration(taskId: string): number {
  const trpc = useTRPC()
  const [generation, setGeneration] = useState(0)
  useSubscription(
    trpc.chat.settings.onChanged.subscriptionOptions(
      { taskId },
      { onData: () => setGeneration((g) => g + 1) }
    )
  )
  return generation
}
