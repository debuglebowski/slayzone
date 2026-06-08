import { randomUUID } from 'node:crypto'
import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import {
  HONORED_ORIGINS,
  type ConversationOrigin
} from '@slayzone/task/shared'

/**
 * Append-only ledger of conversation IDs per task per provider (table
 * `task_conversations`, migration v145). Replaces the mutable
 * `provider_config.{mode}.conversationId` singleton that was vulnerable to
 * eager-persist clobber (see conversation-id-robustness plan, RC1).
 *
 * Reads return the latest HONORED row strictly after any `manual-reset` for
 * the same (task, mode) — encoded in SQL, not a post-filter, so the cutoff
 * is structural.
 */

/** TerminalMode → its legacy `<col>_conversation_id` column prefix. */
const MODE_LEGACY_COL: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  'cursor-agent': 'cursor',
  gemini: 'gemini',
  opencode: 'opencode'
}

const TTL_PENDING_MS = 10 * 60 * 1000 // 10 minutes — pending rows with a pre-minted expected sessionId.
const TTL_PENDING_NULL_EXPECTED_MS = 30 * 1000 // 30 seconds — null-expected rows accept any first observation, so the window is kept tight to limit the temporal-proximity exposure for providers without `--session-id` support.
const FIND_PENDING_RETRY_MS = 100

/**
 * Append a row. Single write API; replaces every direct mutation of the
 * legacy `provider_config.{mode}.conversationId` / `*_conversation_id` fields.
 *
 * Transition-slice dual-write: when `origin` is in HONORED_ORIGINS, the same
 * `batchTxn` mirrors `conversationId` into the legacy JSON field and (if the
 * mode has one) the legacy column. Foreign / pending / manual-reset writes do
 * NOT touch the legacy fields. The follow-up "drop legacy storage" slice
 * deletes the dual-write branch in this one function.
 */
export async function recordConversation(
  db: SlayzoneDb,
  args: {
    taskId: string
    mode: string
    conversationId: string | null
    origin: ConversationOrigin
    pendingMeta?: { usedResume: boolean; spawnedAt: number }
    /**
     * Which JSON key inside `provider_config.{mode}` to mirror to during the
     * transition slice. Defaults to `'conversationId'` (the field non-chat
     * agents read). Chat-mode callers pass `'chatConversationId'` because
     * `provider_config.{mode}.chatConversationId` is the chat-mode-specific
     * field the chat handlers + UI read today.
     */
    legacyJsonField?: 'conversationId' | 'chatConversationId'
  }
): Promise<void> {
  const { taskId, mode, conversationId, origin, pendingMeta } = args
  const legacyJsonField = args.legacyJsonField ?? 'conversationId'
  const id = randomUUID()
  const createdAt = Date.now()
  const meta =
    origin === 'pending-spawn' && pendingMeta
      ? JSON.stringify(pendingMeta)
      : null

  const ops: BatchOp[] = [
    {
      type: 'run',
      sql: `INSERT INTO task_conversations
              (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [id, taskId, mode, conversationId, origin, meta, createdAt]
    }
  ]

  if (HONORED_ORIGINS.has(origin) && conversationId) {
    // Dual-write the legacy JSON field so consumers that still read
    // `provider_config.{mode}.{legacyJsonField}` keep seeing fresh data
    // during the transition slice.
    const jsonPath = `$."${mode}".${legacyJsonField}`
    ops.push({
      type: 'run',
      sql: `UPDATE tasks
              SET provider_config = json_set(coalesce(provider_config, '{}'), ?, ?)
            WHERE id = ?`,
      params: [jsonPath, conversationId, taskId]
    })
    // Legacy `*_conversation_id` columns only exist for the non-chat
    // conversation id. Chat modes never had top-level columns.
    if (legacyJsonField === 'conversationId') {
      const legacyCol = MODE_LEGACY_COL[mode]
      if (legacyCol) {
        ops.push({
          type: 'run',
          sql: `UPDATE tasks SET ${legacyCol}_conversation_id = ? WHERE id = ?`,
          params: [conversationId, taskId]
        })
      }
    }
  } else if (origin === 'manual-reset') {
    // Phase 1 transitional patch (delete in Phase 4): clear the legacy fields
    // so consumers that still read `provider_config.{mode}.conversationId` /
    // `chatConversationId` and the `*_conversation_id` columns immediately see
    // NULL. Without this, the SQL-cutoff in `getCurrentConversationId` works
    // but every live consumer of the legacy field stays bound to the broken
    // id. Clears BOTH JSON keys + the legacy column in one batchTxn — the
    // reset doesn't know whether the broken binding lives under the chat or
    // non-chat key, so we clear both. Foreign-observed writes deliberately
    // do NOT clear the legacy field (those are audit-only).
    ops.push({
      type: 'run',
      sql: `UPDATE tasks
              SET provider_config = json_set(
                    json_set(coalesce(provider_config, '{}'), ?, NULL),
                    ?, NULL)
            WHERE id = ?`,
      params: [
        `$."${mode}".conversationId`,
        `$."${mode}".chatConversationId`,
        taskId
      ]
    })
    const legacyCol = MODE_LEGACY_COL[mode]
    if (legacyCol) {
      ops.push({
        type: 'run',
        sql: `UPDATE tasks SET ${legacyCol}_conversation_id = NULL WHERE id = ?`,
        params: [taskId]
      })
    }
  }

  await db.batchTxn(ops)
}

/**
 * Latest honored conversation id for (taskId, mode), strictly after the most
 * recent `manual-reset` (if any). Encoded as a single SQL query so the cutoff
 * is structural — not a JS-side filter that could expose stale rows under
 * the reset boundary.
 */
export async function getCurrentConversationId(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<string | null> {
  const row = await db.get<{ conversation_id: string | null }>(
    `WITH reset AS (
       SELECT max(created_at) AS at
       FROM task_conversations
       WHERE task_id = ? AND mode = ? AND origin = 'manual-reset'
     )
     SELECT conversation_id
       FROM task_conversations
       WHERE task_id = ? AND mode = ?
         AND origin IN ('slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal','legacy-migration')
         AND created_at > coalesce((SELECT at FROM reset), 0)
       ORDER BY created_at DESC
       LIMIT 1`,
    [taskId, mode, taskId, mode]
  )
  return row?.conversation_id ?? null
}

/** Full audit trail (newest first) — includes foreign + pending + manual-reset rows. */
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
       FROM task_conversations
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
 * Spawn-time provenance anchor for hook-driven providers. MUST complete
 * before the agent process is started — otherwise the agent's SessionStart
 * hook can race ahead, find no pending row, and record `foreign-observed`
 * for a legitimate session.
 */
export async function recordPendingSpawn(
  db: SlayzoneDb,
  args: {
    taskId: string
    mode: string
    /**
     * The sessionId slay expects to observe back from this spawn. `null` for
     * "fresh PTY spawn where slay didn't pre-mint a UUID" — the agent will
     * mint its own. The hook handler treats a NULL-expected pending row as
     * "accept the first observed id as fresh" (temporal-proximity gate only).
     */
    expectedSessionId: string | null
    usedResume: boolean
  }
): Promise<void> {
  await recordConversation(db, {
    taskId: args.taskId,
    mode: args.mode,
    conversationId: args.expectedSessionId,
    origin: 'pending-spawn',
    pendingMeta: { usedResume: args.usedResume, spawnedAt: Date.now() }
  })
}

/**
 * Look up the still-pending spawn for (taskId, mode) within the TTL window.
 * Does a single 100 ms re-read if no row is found, to defend the residual
 * race between `recordPendingSpawn` and the agent's SessionStart hook.
 */
export async function findPendingSpawn(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<{
  /** `null` when slay didn't pre-mint a sessionId — accept the first observed. */
  expectedSessionId: string | null
  usedResume: boolean
  spawnedAt: number
} | null> {
  // Two TTL windows depending on whether the pending row pre-minted a sessionId:
  //   - explicit expected id → wide window (10 min), since binary match is safe
  //     regardless of timing
  //   - null-expected (fresh, provider mints internally) → tight 30 s window,
  //     since the row accepts any first observation and we want to limit the
  //     temporal-proximity exposure
  const cutoffExpected = Date.now() - TTL_PENDING_MS
  const cutoffNull = Date.now() - TTL_PENDING_NULL_EXPECTED_MS
  const query = async (): Promise<{
    conversation_id: string | null
    pending_meta: string | null
  } | null> =>
    (await db.get(
      `SELECT conversation_id, pending_meta
         FROM task_conversations
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
      expectedSessionId: row.conversation_id, // may be null for fresh-without-pre-mint
      usedResume: meta.usedResume,
      spawnedAt: meta.spawnedAt
    }
  } catch {
    return null
  }
}

/**
 * Sweep pending-spawn rows. With no args, prunes anything older than the TTL
 * — the periodic 10-min belt-and-suspenders sweep. With scope, prunes every
 * pending row for that (taskId, mode) regardless of age — call on PTY exit.
 */
export async function prunePendingSpawns(
  db: SlayzoneDb,
  scope?: { taskId: string; mode: string }
): Promise<number> {
  if (scope) {
    const res = await db.run(
      `DELETE FROM task_conversations
         WHERE task_id = ? AND mode = ? AND origin = 'pending-spawn'`,
      [scope.taskId, scope.mode]
    )
    return res.changes
  }
  const cutoff = Date.now() - TTL_PENDING_MS
  const res = await db.run(
    `DELETE FROM task_conversations
       WHERE origin = 'pending-spawn' AND created_at < ?`,
    [cutoff]
  )
  return res.changes
}
