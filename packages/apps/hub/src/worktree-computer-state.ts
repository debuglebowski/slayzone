/**
 * Whether the computer holding a task's worktree can remove it now — the Trash
 * purge's question (`TaskRuntimeAdapters.worktreeComputerState`, final review round 5,
 * R5-1). The purge runs at boot, before any computer is connected; it deletes a task
 * only once its worktree is gone, and runs again on `computer-connected`.
 *
 *   - BOUND (the task's or its project's computer): `ready` while that computer is
 *     usable; `gone` when its record is deleted or revoked — it will never answer, so
 *     it must not hold the purge forever; else `wait`.
 *   - UNBOUND: the worktree is on whichever computer ran the task — the default pick.
 *     `ready` when placement picks a usable one; else `wait` while any computer that
 *     could still come back exists (on a hub with login: one the project's owner
 *     owns), and `gone` when none does.
 *
 * @module hub/worktree-computer-state
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { resolveTaskComputerId } from '@slayzone/computers/server'
import type { WorktreeComputerState } from '@slayzone/task/server'

export interface WorktreeComputerStateDeps {
  db: SlayzoneDb
  requireLogin: boolean
  /** Computers connected and heard from now. */
  usable: () => readonly { computerId: string }[]
  /** Placement's pick for the task (null or a throw: none). */
  forTask: (taskId: string) => Promise<string | null>
}

export function createWorktreeComputerState(
  deps: WorktreeComputerStateDeps
): (taskId: string) => Promise<WorktreeComputerState> {
  const { db } = deps
  // The boot purge can ask before the gateway and placement exist: nothing usable.
  const usable = (): readonly { computerId: string }[] => {
    try {
      return deps.usable()
    } catch {
      return []
    }
  }
  const isUsable = (id: string) => usable().some((c) => c.computerId === id)

  return async (taskId) => {
    const bound = await resolveTaskComputerId(db, taskId)
    if (bound) {
      const row = await db.get<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM computers WHERE id = ?',
        [bound]
      )
      if (!row || row.revoked_at != null) return 'gone'
      return isUsable(bound) ? 'ready' : 'wait'
    }
    const picked = await Promise.resolve()
      .then(() => deps.forTask(taskId))
      .catch(() => null)
    if (picked && isUsable(picked)) return 'ready'
    const live = deps.requireLogin
      ? await db.get(
          `SELECT 1 FROM computers c
             JOIN projects p ON p.owner_user_id = c.owner_user_id
             JOIN tasks t ON t.project_id = p.id
            WHERE t.id = ? AND c.revoked_at IS NULL LIMIT 1`,
          [taskId]
        )
      : await db.get('SELECT 1 FROM computers WHERE revoked_at IS NULL LIMIT 1')
    return live ? 'wait' : 'gone'
  }
}
