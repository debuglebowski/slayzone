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
  /** Runtime key of the in-flight session (entity-model B). */
  sessionId: string
  expectedSessionId: string | null
  usedResume: boolean
  spawnedAt: number
} | null> {
  const cutoffExpected = Date.now() - TTL_PENDING_MS
  const cutoffNull = Date.now() - TTL_PENDING_NULL_EXPECTED_MS
  const query = async (): Promise<{
    id: string
    conversation_id: string | null
    pending_meta: string | null
  } | null> =>
    (await db.get(
      `SELECT id, conversation_id, pending_meta
         FROM agent_sessions
         WHERE task_id = ? AND mode = ? AND origin = 'pending-spawn'
           AND status != 'dead'
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
      sessionId: row.id,
      expectedSessionId: row.conversation_id,
      usedResume: meta.usedResume,
      spawnedAt: meta.spawnedAt
    }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity-model B write lifecycle (plans/agent-sessions.md). One row per spawn:
//   recordSessionSpawn → confirmSessionConversation* (write-once) → markSessionDead
// `bindSessionToTask` is the pool-assignment transition (slice 4).
// ─────────────────────────────────────────────────────────────────────────────

/** Resume eligibility for a confirmed spawn, given what we expected vs observed. */
function resolveSpawnOrigin(
  expectedConversationId: string | null,
  observedConversationId: string,
  usedResume: boolean
): ConversationOrigin {
  // Null-expected = provider mints its own id (codex/gemini) — accept the first
  // observation as a legitimate fresh start (temporal-proximity gate lives in
  // findPendingSpawn's tight TTL).
  if (expectedConversationId === null) return 'slay-spawned-fresh'
  if (observedConversationId === expectedConversationId) {
    return usedResume ? 'slay-spawned-resume' : 'slay-spawned-fresh'
  }
  // Observed id did not match what slay spawned (a manual `--resume X`) →
  // recorded for audit, never honored on read.
  return 'foreign-observed'
}

/**
 * Insert the session row at spawn. `id` is the main-minted runtime PTY key.
 * `status` is `bound` for a task-attached spawn or `pooled` for a warm pool
 * member with no task yet. The row starts as `origin='pending-spawn'`; the
 * conversation id + final origin are filled write-once by
 * `confirmSessionConversation*` when the provider reports its session id.
 */
export async function recordSessionSpawn(
  db: SlayzoneDb,
  args: {
    id: string
    taskId: string | null
    tabId: string | null
    mode: string
    cwd: string | null
    /** Id slay expects the provider to echo back (pre-minted), or null when the
     *  provider mints its own. */
    expectedConversationId: string | null
    usedResume: boolean
    status: 'pooled' | 'bound'
  }
): Promise<void> {
  const createdAt = Date.now()
  const meta = JSON.stringify({ usedResume: args.usedResume, spawnedAt: createdAt })
  await db.run(
    `INSERT INTO agent_sessions
       (id, mode, cwd, task_id, tab_id, conversation_id, origin, status, pending_meta, created_at, bound_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending-spawn', ?, ?, ?, ?, NULL)`,
    [
      args.id,
      args.mode,
      args.cwd,
      args.taskId,
      args.tabId,
      args.expectedConversationId,
      args.status,
      meta,
      createdAt,
      args.status === 'bound' ? createdAt : null
    ]
  )
}

/**
 * Write-once confirm of the provider session id for the spawn keyed by runtime
 * `sessionId`. No-op if the row is already confirmed (origin no longer
 * `pending-spawn`) — structural write-once. Returns the resolved origin, or
 * null if no pending row matched.
 */
export async function confirmSessionConversation(
  db: SlayzoneDb,
  args: { sessionId: string; observedConversationId: string }
): Promise<ConversationOrigin | null> {
  const row = await db.get<{
    conversation_id: string | null
    pending_meta: string | null
  }>(
    `SELECT conversation_id, pending_meta
       FROM agent_sessions
       WHERE id = ? AND origin = 'pending-spawn'`,
    [args.sessionId]
  )
  if (!row) return null
  let usedResume = false
  try {
    if (row.pending_meta) {
      usedResume = (JSON.parse(row.pending_meta) as { usedResume: boolean }).usedResume
    }
  } catch {
    /* default usedResume=false */
  }
  const origin = resolveSpawnOrigin(row.conversation_id, args.observedConversationId, usedResume)
  await db.run(
    `UPDATE agent_sessions
        SET conversation_id = ?, origin = ?
      WHERE id = ? AND origin = 'pending-spawn'`,
    [args.observedConversationId, origin, args.sessionId]
  )
  return origin
}

/**
 * Hook-path confirm: the agent's REST hook knows only (taskId, mode), not the
 * runtime key. Locate the in-flight pending session, then confirm it. Returns
 * the resolved origin + the runtime sessionId, or null if no pending row.
 */
export async function confirmSessionConversationByTaskMode(
  db: SlayzoneDb,
  args: { taskId: string; mode: string; observedConversationId: string }
): Promise<{ origin: ConversationOrigin; sessionId: string } | null> {
  const pending = await findPendingSpawn(db, args.taskId, args.mode)
  if (!pending) return null
  const origin = await confirmSessionConversation(db, {
    sessionId: pending.sessionId,
    observedConversationId: args.observedConversationId
  })
  if (!origin) return null
  return { origin, sessionId: pending.sessionId }
}

/** Mark a session's process exited. Lifecycle-only mutation (never touches a
 *  resume-critical value). */
export async function markSessionDead(db: SlayzoneDb, sessionId: string): Promise<void> {
  await db.run(
    `UPDATE agent_sessions SET status = 'dead', ended_at = ? WHERE id = ?`,
    [Date.now(), sessionId]
  )
}

/**
 * Pool-assignment transition (slice 4): bind a `pooled` session to a task+tab.
 * Set-once — only applies to a row still `pooled` with no task. Returns true if
 * the bind happened.
 */
export async function bindSessionToTask(
  db: SlayzoneDb,
  args: { sessionId: string; taskId: string; tabId: string }
): Promise<boolean> {
  const res = await db.run(
    `UPDATE agent_sessions
        SET task_id = ?, tab_id = ?, status = 'bound', bound_at = ?
      WHERE id = ? AND status = 'pooled' AND task_id IS NULL`,
    [args.taskId, args.tabId, Date.now(), args.sessionId]
  )
  return res.changes > 0
}
