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
 */
export async function listPromptsForTask(
  db: SlayzoneDb,
  taskId: string,
  agentId: string
): Promise<AgentPrompt[]> {
  return (await db
    .prepare(
      `SELECT id, task_id, agent_id, cli_session_id, text, created_at
       FROM agent_prompts
       WHERE task_id = ? AND agent_id = ?
       ORDER BY created_at ASC, rowid ASC`
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
