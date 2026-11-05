/**
 * The computer gate on a git op, on hubs with login: on a task's checkout, the
 * computer it lands on must be the one serving that task.
 *
 * Whether the CALLER may use that computer at all (a computer works only for its
 * owner) is NOT asked here: it is the gateway's one owner check, for every request
 * (`computer-request-authorizer.ts`, G2). Gating a git op only as "the task's work"
 * once let user B aim A's worktree through a `..` path and run on A's computer (F2).
 *
 * Hub-internal work — the conversation healer's branch probe, the worktree colour
 * detector — has no caller: the hub's own read of a path it chose, not gated.
 * Callers' targets are owner-checked before this (`TRPC_OWNER_POLICY`).
 *
 * @module hub/git-op-gate
 */
import type { ComputerWorkGate } from '@slayzone/computer-transport/server'

export interface GitOpTargetResolved {
  taskId?: string
  projectId?: string
  computerId?: string | null
}

export function createGitOpGate(
  gate: ComputerWorkGate | undefined,
  currentActor: () => string | null | undefined
): (computerId: string, target: GitOpTargetResolved) => Promise<void> {
  return async (computerId, target) => {
    if (!gate || !currentActor()) return
    // Whether the CALLER may use this computer is the gateway's one owner check
    // (computer-request-authorizer.ts), asked for every request. Here only the
    // routing question: on a task's checkout, that computer must be the one serving
    // the task.
    if (target.taskId) await gate(computerId, { kind: 'task', id: target.taskId })
  }
}
