/**
 * THE owner check for hub→computer work (G2), on a hub with login: every request the
 * gateway sends ({@link HubComputerGatewayOptions.authorizeRequest}) asks here, so no
 * routed procedure — git ops, gh, AI config, test scan, turn git, fs, exec,
 * processes, terminals, chat — can reach a computer its caller does not own, by any
 * path form or target. A computer works only for its owner; an admin is no exception
 * (`@slayzone/api` computer-access.ts).
 *
 * No caller (the hub's own background work: the conversation healer, the worktree
 * colour detector, reconnect sync): not a caller's request, nothing to check (R7).
 * Hub-run work started inside a caller's request (a policy push to every computer)
 * runs as the hub: `runAsSecurityActor(null, …)`.
 *
 * Whether a computer may do a given task's WORK (does it serve that task?) is a
 * separate question, asked by the backends that route that work.
 *
 * @module hub/computer-request-authorizer
 */
import type { ComputerWorkGate } from '@slayzone/computer-transport/server'
import { currentSecurityContext } from '@slayzone/platform/security-log'

export function createComputerRequestAuthorizer(
  gate: ComputerWorkGate | undefined
): ((computerId: string, method: string) => Promise<void>) | undefined {
  if (!gate) return undefined
  return async (computerId) => {
    if (!currentSecurityContext()?.actor) return
    await gate(computerId, null)
  }
}
