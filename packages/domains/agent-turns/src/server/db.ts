import type { SlayzoneDb } from '@slayzone/platform'
import type { AgentTurn, AgentTurnRange } from '../shared/types'

const MAX_TURNS_PER_WORKTREE = 50

export interface InsertTurn {
  id: string
  worktree_path: string
  task_id: string | null
  terminal_tab_id: string
  snapshot_sha: string
  /** HEAD SHA at snap time. See AgentTurn.head_sha_at_snap. */
  head_sha_at_snap: string
  prompt_preview: string
  created_at: number
}

export async function insertTurn(db: SlayzoneDb, t: InsertTurn): Promise<void> {
  await db.prepare(
    `INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    t.id,
    t.worktree_path,
    t.task_id,
    t.terminal_tab_id,
    t.snapshot_sha,
    t.head_sha_at_snap,
    t.prompt_preview,
    t.created_at
  )
  // Bump task-level interaction marker so tree-view "Last interaction" sort
  // reflects this turn. Skips when the turn isn't task-scoped.
  if (t.task_id) {
    await db.prepare(
      `UPDATE tasks SET last_interaction_at = ? WHERE id = ? AND (last_interaction_at IS NULL OR last_interaction_at < ?)`
    ).run(t.created_at, t.task_id, t.created_at)
  }
}

export async function deleteTurn(db: SlayzoneDb, id: string): Promise<void> {
  await db.prepare(`DELETE FROM agent_turns WHERE id = ?`).run(id)
}

export async function getTurn(db: SlayzoneDb, id: string): Promise<AgentTurn | null> {
  return (
    (await db.prepare(`SELECT * FROM agent_turns WHERE id = ?`).get(id) as AgentTurn | undefined) ??
    null
  )
}

/** Latest turn for a worktree — used for snapshot deduplication. */
export async function getLatestTurnForWorktree(
  db: SlayzoneDb,
  worktreePath: string
): Promise<AgentTurn | null> {
  return (
    (await db
      .prepare(`SELECT * FROM agent_turns WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 1`)
      .get(worktreePath) as AgentTurn | undefined) ?? null
  )
}

/**
 * All turns for a worktree, oldest first, paired with the previous row's
 * snapshot so callers can diff `prev_snapshot_sha..snapshot_sha` for that
 * turn's changes. `prev_snapshot_sha` is null for the first row.
 */
export async function listTurnsForWorktree(
  db: SlayzoneDb,
  worktreePath: string
): Promise<AgentTurnRange[]> {
  const rows = (await db
    .prepare(
      `SELECT a.*, t.title AS task_title
     FROM agent_turns a
     LEFT JOIN tasks t ON t.id = a.task_id
     WHERE a.worktree_path = ?
     ORDER BY a.created_at ASC`
    )
    .all(worktreePath)) as (AgentTurn & { task_title: string | null })[]
  return rows.map((row, idx) => ({
    ...row,
    prev_snapshot_sha: idx === 0 ? null : rows[idx - 1].snapshot_sha
  }))
}

/** Return IDs of the oldest excess rows beyond MAX_TURNS_PER_WORKTREE. */
export async function findTurnsToPrune(db: SlayzoneDb, worktreePath: string): Promise<string[]> {
  const rows = (await db
    .prepare(`SELECT id FROM agent_turns WHERE worktree_path = ? ORDER BY created_at ASC`)
    .all(worktreePath)) as { id: string }[]
  if (rows.length <= MAX_TURNS_PER_WORKTREE) return []
  return rows.slice(0, rows.length - MAX_TURNS_PER_WORKTREE).map((r) => r.id)
}
