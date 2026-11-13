/**
 * Prompt history and turn snapshots live only on the computer running the task's
 * agents (robustness plan §9, P0; hub v207). With it offline there is nothing to
 * show: the hub keeps no copy. Readers throw this; the routers answer it as a
 * precondition (PRECONDITION_FAILED) and the UI says "computer offline".
 */
import { TRPCError } from '@trpc/server'

export class AgentHistoryOfflineError extends Error {
  readonly code = 'computer-offline'
  constructor() {
    super('The computer holding this task’s history is offline.')
    this.name = 'AgentHistoryOfflineError'
  }
}

/** Run a read; an offline computer becomes the precondition the UI shows. */
export async function onComputer<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof AgentHistoryOfflineError)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error })
    throw error
  }
}
