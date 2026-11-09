import type { ErasureReport, ErasureScope } from '../shared'

export interface ErasureManifest {
  dependencies: string[]
  scope: ErasureScope
  ownerUserId: string | null
  projectIds: string[]
  taskIds: string[]
  artifactIds: string[]
  tabIds: string[]
  conversationIds: string[]
  blobHashes: string[]
  artifactTasks: Array<{ artifactId: string; taskId: string }>
  tabTasks: Array<{ tabId: string; taskId: string }>
  computers: Array<{ id: string; taskIds: string[] }>
  worktrees: ErasureWorktree[]
  counts: ErasureReport['counts']
  /** Local cleanup progress (absent before the first pass; see index.ts localOf). */
  local?: ErasureLocalSteps
}

/**
 * Which local steps finished, so a retry never repeats one, and which content
 * generations a database compaction has covered. `changes` counts passes that removed
 * content from a store (diagnostics attempts, clearing worktree paths); `hub` counts
 * those touching the hub database itself (the commit is generation 0). The job's
 * files and databases are clean once both `*Compacted` values reach them.
 */
export interface ErasureLocalSteps {
  diagnostics?: true
  files?: true
  changes: number
  hub: number
  compactedChanges?: number
  hubCompacted?: number
}

export interface ErasureJob {
  id: string
  scope: string
  owner_user_id: string | null
  actor_user_id: string | null
  manifest: string
  db_erased: number
  local_erased: number
  gc_generation: number
  state: ErasureReport['state']
  failure_codes: string
  retained_shared_blobs: number
  retained_backup_blobs: number
  created_at: string
  completed_at: string | null
}

/**
 * A task worktree to remove. Its computer is resolved the way task work routes: the
 * computer recorded when it was made, else the task's (or its project's) computer —
 * both captured while the task row exists — else the hub's default computer for the
 * work's owner, picked once a computer is usable and then persisted, so a retry never
 * goes to a computer that became the default later. Fields marked optional are absent
 * from manifests written before they existed.
 */
export interface ErasureWorktree {
  taskId: string
  /** The task's project, captured before the task row is erased. */
  projectId?: string
  /** That project's owner (null without accounts). */
  ownerUserId?: string | null
  computerId: string | null
  repoPath: string | null
  /** The project's folder on each computer, captured before project rows can be erased. */
  repoPaths?: Array<{ computerId: string; path: string }>
  path: string
  deleted: boolean
  /** Its computer is revoked or removed, or no computer could ever hold it: it is not
   *  retried automatically. Only the operator procedure can verify its removal. */
  gone?: boolean
}

/** The hub's pick for a worktree no task/project binding names. `gone`: no computer
 *  that could hold it can ever answer; else null means none is usable yet. */
export type ErasureWorktreeComputer = { computerId: string } | { computerId: null; gone: boolean }

/**
 * Whether a task outside the erased set still uses this worktree directory — then it
 * is shared and kept. A task's holding computer is its recorded one, else its own or
 * its project's; one that names none (an unbound task) counts as the same computer,
 * like a target whose computer is not known yet: removing a directory a live task
 * still uses is worse than keeping one. Params: path, erased-ids JSON, computer, computer.
 */
export const SHARED_WORKTREE_SQL = `SELECT 1 FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
  WHERE t.worktree_path=? AND t.id NOT IN (SELECT value FROM json_each(?))
    AND (? IS NULL OR coalesce(t.worktree_computer_id,t.computer_id,p.default_computer_id) IS NULL
      OR coalesce(t.worktree_computer_id,t.computer_id,p.default_computer_id)=?)
  LIMIT 1`

/** Record that `computerId` holds data of `taskId` (idempotent). */
export function addComputerTask(m: ErasureManifest, computerId: string, taskId: string): void {
  const target = m.computers.find((c) => c.id === computerId)
  if (!target) m.computers.push({ id: computerId, taskIds: [taskId] })
  else if (!target.taskIds.includes(taskId)) target.taskIds.push(taskId)
}
