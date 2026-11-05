/**
 * The computer gate on a git op, on hubs with login. A caller's op is gated as what
 * it works on: a task's checkout as that task's work, anything else as the caller's
 * own request (a computer works only for its owner). Hub-internal work — the
 * conversation healer's branch probe, the worktree colour detector — has no caller:
 * it is the hub's own read of a path it chose, so there is no caller to gate.
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
    await gate(computerId, target.taskId ? { kind: 'task', id: target.taskId } : null)
  }
}
