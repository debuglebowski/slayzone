/**
 * One `exec.run` on a computer, with a request timeout that outlives the command:
 * its own `timeoutMs` (the computer ends it then, SIGTERM → SIGKILL after 2 s) plus
 * room for that kill and the reply. Every hub caller — automations, the conflict
 * analysis, terminal settings probes — goes through here, so none falls back to the
 * gateway's 30 s default.
 *
 * @module hub/computer-exec-run
 */
import {
  HubToComputerMethods,
  execRunResultSchema,
  type ExecRunParams,
  type ExecRunResult
} from '@slayzone/computer-transport/shared'

/** The computer's kill grace (2 s) plus the reply's trip and validation. */
export const EXEC_RUN_REPLY_GRACE_MS = 15_000

export interface ExecRunGateway {
  request(computerId: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>
}

export async function execRunOnComputer(
  gateway: ExecRunGateway,
  computerId: string,
  params: ExecRunParams
): Promise<ExecRunResult> {
  return execRunResultSchema.parse(
    await gateway.request(
      computerId,
      HubToComputerMethods.execRun,
      params,
      params.timeoutMs + EXEC_RUN_REPLY_GRACE_MS
    )
  )
}
