import { useQueryClient } from '@tanstack/react-query'
import { Alert } from 'react-native'
import type { BoardData } from '../hub-board'
import { useTRPC, useTRPCClient } from '../trpc'
import { applyMovePlan, type MovePlan } from './moves'
import { sendMovePlan } from './send-move'

/**
 * Carries out a move on the hub of the nearest `HubScope` — the board's project's hub,
 * which owns every task on it. Optimistic like desktop: the board in that hub's cache
 * (the one its feed shows) changes at once; the writes go out together (`task.update`,
 * `task.reorder` with the full list, `task.setBlockers` when leaving Blocked); a
 * failure puts the board back as it was, reloads it, and says why. The hub's own
 * "tasks changed" push reloads the board after a success.
 */
export function useBoardMoves(): (plan: MovePlan) => Promise<void> {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()

  return async (plan) => {
    const filter = trpc.task.loadBoardData.queryFilter()
    // A reload under way would land the board as it was before the move.
    await queryClient.cancelQueries(filter)
    const snapshot = queryClient.getQueriesData<BoardData>(filter)
    for (const [key, data] of snapshot) {
      if (data) queryClient.setQueryData(key, applyMovePlan(data, plan))
    }

    await sendMovePlan(client, plan).catch((error: unknown) => {
      for (const [key, data] of snapshot) queryClient.setQueryData(key, data)
      void queryClient.invalidateQueries(filter)
      Alert.alert("Couldn't move the task", error instanceof Error ? error.message : String(error))
    })
  }
}
