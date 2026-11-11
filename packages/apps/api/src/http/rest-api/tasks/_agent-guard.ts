import type { Response } from 'express'
import type { RestApiDeps } from '../types'
import { completionRefusal } from '../../task-completion-guard'

/**
 * The CLI's completion guard (`completionRefusal`) as a REST answer: 409
 * `agent_mid_reply` naming `--force`. Returns true when it refused; the caller
 * then writes nothing.
 */
export async function refuseCompletionWhileMidReply(
  deps: RestApiDeps,
  res: Response,
  taskId: string,
  force: boolean
): Promise<boolean> {
  const error = await completionRefusal(deps.taskAgents, taskId, {
    force,
    forceHint: 'Re-run with --force to complete anyway.'
  })
  if (error === null) return false
  res.status(409).json({ ok: false, code: 'agent_mid_reply', error })
  return true
}
