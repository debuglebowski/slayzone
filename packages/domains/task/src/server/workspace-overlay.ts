import type { SlayzoneDb } from '@slayzone/platform'

/**
 * Tasks as one user sees them (T-100): a task they did not create carries THEIR
 * personal workspace — the computer they pinned, whether their worktree / custom
 * folder exists, the branch their worktree merges into — in the same fields the
 * creator's sit in on the task row. A client reads `has_worktree`, `computer_id` …
 * and gets its user's own, unchanged. No user (a hub without login, the hub's own
 * work) or the creator: the task row as is.
 */
export async function overlayWorkspaces<T extends { id: string }>(
  db: SlayzoneDb,
  tasks: T[],
  userId: string | null | undefined
): Promise<T[]> {
  if (!userId || tasks.length === 0) return tasks
  const rows = await db.all<{
    id: string
    creator: string | null
    computer_id: string | null
    has_worktree: number | null
    has_base_dir: number | null
    worktree_computer_id: string | null
    worktree_parent_branch: string | null
  }>(
    `SELECT t.id, COALESCE(t.created_by_user_id, p.owner_user_id) AS creator,
            w.computer_id, w.has_worktree, w.has_base_dir, w.worktree_computer_id,
            w.worktree_parent_branch
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN task_workspaces w ON w.task_id = t.id AND w.user_id = ?
      WHERE t.id IN (SELECT value FROM json_each(?))`,
    [userId, JSON.stringify(tasks.map((t) => t.id))]
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  return tasks.map((task) => {
    const r = byId.get(task.id)
    if (!r || r.creator === null || r.creator === userId) return task
    return {
      ...task,
      computer_id: r.computer_id ?? null,
      has_worktree: r.has_worktree === 1,
      has_base_dir: r.has_base_dir === 1,
      worktree_computer_id: r.worktree_computer_id ?? null,
      worktree_parent_branch: r.worktree_parent_branch ?? null
    }
  })
}

/** {@link overlayWorkspaces} for one task (or none). */
export async function overlayWorkspace<T extends { id: string }>(
  db: SlayzoneDb,
  task: T | null | undefined,
  userId: string | null | undefined
): Promise<T | null> {
  if (!task) return null
  return (await overlayWorkspaces(db, [task], userId))[0] ?? null
}
