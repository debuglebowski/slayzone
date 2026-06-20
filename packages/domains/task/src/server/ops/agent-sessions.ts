import type { SlayzoneDb } from '@slayzone/platform'
import type { ConversationOrigin } from '@slayzone/task/shared'

/**
 * Read-side of the first-class agent-session entity (tables `agent_sessions` +
 * `session_resets`, migration v147). See plans/agent-sessions.md.
 *
 * This module is the slice-2 replacement for the read functions in
 * `task-conversations.ts`: same semantics, new source of truth. During the
 * transition slice both tables are written (triple-write in
 * `recordConversation`); these readers target the new tables so a parity test
 * can assert they agree with the v145 ledger before any caller cuts over.
 *
 * A session's resume eligibility is gated by `origin` (HONORED set) and by the
 * `session_resets` cutoff for its (task, mode) — the cutoff is encoded in SQL,
 * not a JS post-filter, so a reset can never be silently undone.
 */

const TTL_PENDING_MS = 10 * 60 * 1000 // explicit pre-minted expected id → wide window.
const TTL_PENDING_NULL_EXPECTED_MS = 30 * 1000 // null-expected → tight window (temporal-proximity gate only).
const FIND_PENDING_RETRY_MS = 100

/**
 * Latest honored conversation id for (taskId, mode), strictly after the most
 * recent reset in `session_resets` (if any). The reset cutoff is a structural
 * SQL boundary — identical semantics to the v145
 * `getCurrentConversationId`, with the cutoff sourced from `session_resets`
 * instead of an in-table `manual-reset` row.
 */
export async function getCurrentConversationId(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<string | null> {
  const row = await db.get<{ conversation_id: string | null }>(
    `WITH reset AS (
       SELECT max(created_at) AS at
       FROM session_resets
       WHERE task_id = ? AND mode = ?
     )
     SELECT conversation_id
       FROM agent_sessions
       WHERE task_id = ? AND mode = ?
         AND conversation_id IS NOT NULL
         AND origin IN ('slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal','legacy-migration')
         AND created_at > coalesce((SELECT at FROM reset), 0)
       ORDER BY created_at DESC
       LIMIT 1`,
    [taskId, mode, taskId, mode]
  )
  return row?.conversation_id ?? null
}

/**
 * Full audit trail of sessions for (taskId, mode), newest first — includes
 * foreign + pending rows. (Reset events live in `session_resets` and are not
 * part of the session history.)
 */
export async function listConversationHistory(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<
  Array<{
    conversationId: string | null
    origin: ConversationOrigin
    createdAt: number
  }>
> {
  const rows = await db.all<{
    conversation_id: string | null
    origin: ConversationOrigin
    created_at: number
  }>(
    `SELECT conversation_id, origin, created_at
       FROM agent_sessions
       WHERE task_id = ? AND mode = ?
       ORDER BY created_at DESC`,
    [taskId, mode]
  )
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    origin: r.origin,
    createdAt: r.created_at
  }))
}

/**
 * Look up the still-pending spawn for (taskId, mode) within the TTL window.
 * Mirror of `task-conversations.findPendingSpawn` against `agent_sessions`.
 * One 100 ms re-read defends the race between the pending write and the
 * agent's SessionStart hook.
 */
export async function findPendingSpawn(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<{
  expectedSessionId: string | null
  usedResume: boolean
  spawnedAt: number
} | null> {
  const cutoffExpected = Date.now() - TTL_PENDING_MS
  const cutoffNull = Date.now() - TTL_PENDING_NULL_EXPECTED_MS
  const query = async (): Promise<{
    conversation_id: string | null
    pending_meta: string | null
  } | null> =>
    (await db.get(
      `SELECT conversation_id, pending_meta
         FROM agent_sessions
         WHERE task_id = ? AND mode = ? AND origin = 'pending-spawn'
           AND (
             (conversation_id IS NOT NULL AND created_at >= ?)
             OR (conversation_id IS NULL AND created_at >= ?)
           )
         ORDER BY created_at DESC
         LIMIT 1`,
      [taskId, mode, cutoffExpected, cutoffNull]
    )) ?? null

  let row = await query()
  if (!row) {
    await new Promise((r) => setTimeout(r, FIND_PENDING_RETRY_MS))
    row = await query()
  }
  if (!row || !row.pending_meta) return null
  try {
    const meta = JSON.parse(row.pending_meta) as {
      usedResume: boolean
      spawnedAt: number
    }
    return {
      expectedSessionId: row.conversation_id,
      usedResume: meta.usedResume,
      spawnedAt: meta.spawnedAt
    }
  } catch {
    return null
  }
}
