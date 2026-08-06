import type { SlayzoneDb } from '@slayzone/platform'
import type { AgentPrompt } from '../shared/types'

/** Keep each (task, agent) prompt history bounded. Oldest beyond this are pruned. */
export const MAX_PROMPTS_PER_AGENT = 500

export interface InsertPrompt {
  id: string
  task_id: string
  agent_id: string
  cli_session_id: string | null
  text: string
  created_at: number
}

export async function insertPrompt(db: SlayzoneDb, p: InsertPrompt): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(p.id, p.task_id, p.agent_id, p.cli_session_id, p.text, p.created_at)
}

/**
 * All prompts sent to one task's agent of the given mode, oldest first
 * (chronological — reads like a transcript). `rowid` tiebreaks same-ms inserts.
 *
 * Prompts belonging to a session the user DELETED from the sessions sidebar are
 * excluded (`session_deletions`, migration v157): deleting a session removes it
 * from the task, and leaving its messages behind in the message history would
 * contradict that. `cli_session_id` is the same value as
 * `agent_sessions.conversation_id`, and `agent_id` is the mode, so the tombstone
 * joins directly. Prompts with a NULL `cli_session_id` are never attributable to
 * a session and always survive (NULL never equals a tombstone's id).
 */
export async function listPromptsForTask(
  db: SlayzoneDb,
  taskId: string,
  agentId: string
): Promise<AgentPrompt[]> {
  return (await db
    .prepare(
      `SELECT p.id, p.task_id, p.agent_id, p.cli_session_id, p.text, p.created_at
       FROM agent_prompts p
       WHERE p.task_id = ? AND p.agent_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM session_deletions d
            WHERE d.task_id = p.task_id
              AND d.mode = p.agent_id
              AND d.conversation_id = p.cli_session_id
         )
       ORDER BY p.created_at ASC, p.rowid ASC`
    )
    .all(taskId, agentId)) as AgentPrompt[]
}

/** Delete the oldest rows beyond MAX_PROMPTS_PER_AGENT for one (task, agent). */
export async function prunePrompts(
  db: SlayzoneDb,
  taskId: string,
  agentId: string
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM agent_prompts
       WHERE id IN (
         SELECT id FROM agent_prompts
         WHERE task_id = ? AND agent_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )`
    )
    .run(taskId, agentId, MAX_PROMPTS_PER_AGENT)
}
