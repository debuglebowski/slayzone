/**
 * The computer gate on a git op, on hubs with login.
 *
 * A caller's op needs the CALLER to be allowed on the computer it lands on (a
 * computer works only for its owner) — whatever its path says; on a task's
 * checkout, the computer must also serve that task. Gating it only as "the task's
 * work" (does the computer serve the task?) let user B aim A's worktree — through a
 * `..` path the owner policy read as hub-wide — and run on A's computer (F2).
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
    // The caller's own request: a computer works only for its owner.
    await gate(computerId, null)
    // A task's checkout: that computer must also be the one serving the task.
    if (target.taskId) await gate(computerId, { kind: 'task', id: target.taskId })
  }
}
