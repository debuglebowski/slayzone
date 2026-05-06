import type { Database } from 'better-sqlite3'
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

export function insertTurn(db: Database, t: InsertTurn): void {
  db.prepare(
    `INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(t.id, t.worktree_path, t.task_id, t.terminal_tab_id, t.snapshot_sha, t.head_sha_at_snap, t.prompt_preview, t.created_at)
}

export function deleteTurn(db: Database, id: string): void {
  db.prepare(`DELETE FROM agent_turns WHERE id = ?`).run(id)
}

export function getTurn(db: Database, id: string): AgentTurn | null {
  return (db.prepare(`SELECT * FROM agent_turns WHERE id = ?`).get(id) as AgentTurn | undefined) ?? null
}

/** Latest turn for a worktree — used for snapshot deduplication. */
export function getLatestTurnForWorktree(db: Database, worktreePath: string): AgentTurn | null {
  return (db.prepare(
    `SELECT * FROM agent_turns WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 1`
  ).get(worktreePath) as AgentTurn | undefined) ?? null
}

/**
 * All turns for a worktree, oldest first, paired with the previous row's
 * snapshot so callers can diff `prev_snapshot_sha..snapshot_sha` for that
 * turn's changes. `prev_snapshot_sha` is null for the first row.
 */
export function listTurnsForWorktree(db: Database, worktreePath: string): AgentTurnRange[] {
  const rows = db.prepare(
    `SELECT a.*, t.title AS task_title
     FROM agent_turns a
     LEFT JOIN tasks t ON t.id = a.task_id
     WHERE a.worktree_path = ?
     ORDER BY a.created_at ASC`
  ).all(worktreePath) as (AgentTurn & { task_title: string | null })[]
  return rows.map((row, idx) => ({
    ...row,
    prev_snapshot_sha: idx === 0 ? null : rows[idx - 1].snapshot_sha,
  }))
}

/** Return IDs of the oldest excess rows beyond MAX_TURNS_PER_WORKTREE. */
export function findTurnsToPrune(db: Database, worktreePath: string): string[] {
  const rows = db.prepare(
    `SELECT id FROM agent_turns WHERE worktree_path = ? ORDER BY created_at ASC`
  ).all(worktreePath) as { id: string }[]
  if (rows.length <= MAX_TURNS_PER_WORKTREE) return []
  return rows.slice(0, rows.length - MAX_TURNS_PER_WORKTREE).map((r) => r.id)
}
