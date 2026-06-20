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

/**
 * One user prompt submitted to a task's agent, captured from the agent's
 * `UserPromptSubmit` hook (clean exact text — unlike raw PTY stdin). Powers the
 * agent-terminal "messages" sidebar. Grouped by `task_id` + `agent_id` (mode);
 * the sidebar shows the task's MAIN agent by filtering on its current mode.
 */
export interface AgentPrompt {
  id: string
  task_id: string
  /** Terminal mode the prompt was sent to (claude-code, codex, ...). */
  agent_id: string
  /** Upstream CLI session id from the hook payload, if present. */
  cli_session_id: string | null
  text: string
  created_at: number
}
