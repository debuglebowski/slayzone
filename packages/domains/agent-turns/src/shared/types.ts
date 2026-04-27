export interface AgentTurn {
  id: string
  worktree_path: string
  /** Nullable: which task triggered the turn (for attribution). NULL if task deleted. */
  task_id: string | null
  terminal_tab_id: string
  snapshot_sha: string
  /**
   * HEAD commit SHA at the moment the snap was taken. The snap commit is built
   * with `commit-tree -p HEAD`, so this == `snapshot_sha^`. Stored explicitly
   * so list-time filtering can drop pre-commit ghosts via a pure SQL check
   * (no git spawn, no cache poisoning). NULL only for legacy rows inserted
   * before migration 122 when backfill failed (repo gone, etc.) — those are
   * treated as stale and dropped.
   */
  head_sha_at_snap: string | null
  prompt_preview: string
  created_at: number
}

/**
 * Computed view: turn paired with previous turn's snapshot SHA so the diff
 * panel can fetch `git diff <prev>..<this>`. `prev_snapshot_sha` is null for
 * the first turn in a worktree. `task_title` joined from tasks table for
 * tooltip display; null if task deleted or task_id null.
 */
export interface AgentTurnRange extends AgentTurn {
  prev_snapshot_sha: string | null
  task_title: string | null
}
