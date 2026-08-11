import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { type ConversationOrigin, HONORED_ORIGINS_SQL } from '@slayzone/task/shared'
import { agentSessionsEvents } from '../events'

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

/**
 * Correlated exclusion of user-deleted sessions, for embedding in a query whose
 * `agent_sessions` row is aliased `s`. A delete is a tombstone in
 * `session_deletions` (migration v157), never a `DELETE FROM` — this subsystem is
 * append-only because the provenance rows are the only evidence available when a
 * task resumes the wrong conversation.
 *
 * Every reader that answers "which sessions does this task have?" or "what should
 * it resume?" interpolates THIS, so the exclusion is structural SQL rather than a
 * JS post-filter a caller could forget — the same reason the reset cutoff is
 * encoded in SQL. Scoped to (task, mode, conversation): one provider conversation
 * id can legitimately appear under two modes for a task.
 */
const NOT_DELETED_SQL = `NOT EXISTS (
       SELECT 1 FROM session_deletions d
        WHERE d.task_id = s.task_id
          AND d.mode = s.mode
          AND d.conversation_id = s.conversation_id
     )`

/**
 * When a session became THIS task's. For a direct task spawn that is the spawn
 * itself (`recordSessionSpawn` sets `bound_at = created_at` for `status='bound'`);
 * for a warm-pool agent it is the ADOPTION, which can be minutes or hours after
 * the process was pre-booted.
 *
 * Every ordering and every reset cutoff uses this, never raw `created_at`. Using
 * spawn time silently excluded the one session that mattered in the a426d99d
 * incident: pre-booted 08:27:11, reset cutoff 08:29:38, adopted 08:29:40 — two
 * seconds on the wrong side of a boundary it had nothing to do with, which
 * orphaned a 1.8 MB transcript for the rest of the task's life.
 */
export const OWNED_AT_SQL = `coalesce(s.bound_at, s.created_at)`

/**
 * THE definition of "a session this task can resume", for embedding in a query
 * whose `agent_sessions` row is aliased `s`. `resetAtExpr` is the caller's
 * cutoff expression — a correlated subquery for the single-row reader, a joined
 * column for the batched one.
 *
 * Exported and interpolated rather than re-typed, because this predicate lives in
 * two readers that MUST agree (`getCurrentConversationId` here, and
 * `attachCurrentConversationByMode` in shared.ts, which feeds the renderer's
 * resume hint). They are the same question asked in two shapes; a copy that drifts
 * means the terminal resumes one conversation while the sidebar shows another.
 *
 * `first_turn_at IS NOT NULL` is the resumability proof (migration v158). A
 * provider writes its transcript at the FIRST TURN, not at startup, so an id that
 * has never taken one cannot be resumed by definition — `claude --resume <id>`
 * answers `No conversation found with session ID:`. Skipping such a row falls
 * through to the newest session that IS resumable, which is what "the task's
 * conversation" has always meant; rows carrying intent (`user-selected`,
 * `in-band-clear`, a reset) are marked proven at write time, so they never fall
 * through. See `markSessionFirstTurn`.
 */
export function resumableSessionSql(resetAtExpr: string): string {
  return `${ownedSessionSql(resetAtExpr)}
         AND ${HAS_TURN_SQL}`
}

/**
 * The resumability proof (migration v158), as a correlated EXISTS for a query
 * whose `agent_sessions` row is aliased `s` — structural SQL for the same reason
 * `NOT_DELETED_SQL` is.
 *
 * A provider writes its transcript at the FIRST TURN, not at startup. Between
 * spawn and first turn the id exists in slay but not on disk, so `--resume <id>`
 * can only answer `No conversation found with session ID:`. The warm pool
 * stretched that window from seconds to hours.
 */
const HAS_TURN_SQL = `EXISTS (
       SELECT 1 FROM session_turns t
        WHERE t.conversation_id = s.conversation_id
     )`

/**
 * Ownership without the resumability proof: sessions this task legitimately has,
 * after the last reset, deletions excluded.
 *
 * Split out for the healer, whose entire job is to look at ids that may NOT be
 * proven and ask the disk. Keeping it as the shared base means "which sessions
 * are this task's" is defined once even though two callers want different
 * amounts of certainty.
 */
export function ownedSessionSql(resetAtExpr: string): string {
  return `s.conversation_id IS NOT NULL
         AND s.origin IN (${HONORED_ORIGINS_SQL})
         AND ${OWNED_AT_SQL} > coalesce(${resetAtExpr}, 0)
         AND ${NOT_DELETED_SQL}`
}

/**
 * Modes whose first turn slay can actually observe (their agent hooks post
 * `UserPromptSubmit`). For every other provider the proof is unavailable, so its
 * sessions are marked proven at spawn — the mode-specific knowledge lives at
 * WRITE time so the read predicate stays one uniform `first_turn_at IS NOT NULL`
 * with no provider allowlist in SQL.
 */
export const TURN_TRACKED_MODES: ReadonlySet<string> = new Set(['claude-code'])

/**
 * The AGENT a mode runs — the mode id itself for a built-in, or
 * `terminal_modes.type` for a user-defined provider wrapping one.
 *
 * Turn-tracking is a property of the AGENT (whose hooks post the turn), never of
 * the mode wrapping it. Testing the raw mode id classified every custom provider
 * as "turns unobservable" and so marked its sessions resumability-proven at
 * spawn — before any transcript exists. The next restart then resumed an id
 * `--resume` cannot find, which fails, trips the healer, and RESETS the task:
 * the user sees an empty chat and loses the conversation pointer.
 */
async function resolveTurnTrackedAgent(db: SlayzoneDb, mode: string): Promise<string> {
  if (TURN_TRACKED_MODES.has(mode)) return mode
  const row = await db.get<{ type?: string }>('SELECT type FROM terminal_modes WHERE id = ?', [
    mode
  ])
  return row?.type ?? mode
}

const TTL_PENDING_MS = 10 * 60 * 1000 // explicit pre-minted expected id → wide window.
const TTL_PENDING_NULL_EXPECTED_MS = 30 * 1000 // null-expected → tight window (temporal-proximity gate only).
const FIND_PENDING_RETRY_MS = 100

/**
 * The conversation this task should resume: the most recently OWNED (bound)
 * session, after the last reset, that is honored, not deleted, and provably
 * resumable. The whole predicate is `resumableSessionSql` — a structural SQL
 * boundary, so a reset can never be silently undone and an unresumable id can
 * never be handed out.
 *
 * Ordering is by `OWNED_AT_SQL`, not `created_at`: a warm-pool agent is
 * pre-booted long before the task adopts it, and spawn order says nothing about
 * which session is the task's current one.
 *
 * The `NOT_DELETED_SQL` guard is defence in depth: the UI refuses to delete the
 * CURRENT session, so a tombstoned id should never be the newest honored row
 * anyway. But an agent that rotates its own id (`in-band-clear`) can append an
 * honored row naming any conversation at any time, and a deleted session must
 * never come back as a resume target through that door.
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
     SELECT s.conversation_id AS conversation_id
       FROM agent_sessions s
       WHERE s.task_id = ? AND s.mode = ?
         AND ${resumableSessionSql('(SELECT at FROM reset)')}
       ORDER BY ${OWNED_AT_SQL} DESC
       LIMIT 1`,
    [taskId, mode, taskId, mode]
  )
  return row?.conversation_id ?? null
}

/**
 * Every conversation this task could legitimately fall back to, newest-owned
 * first — the healer's candidate set when the stored id turns out to have no
 * transcript on disk.
 *
 * Sourced from `agent_sessions` rather than
 * `provider_config.{mode}.conversationHistory`, which is appended by the
 * SessionStart persist path and is therefore ALWAYS EMPTY for a warm-pool agent:
 * a pooled process boots with no `SLAYZONE_TASK_ID`, so its SessionStart cannot
 * be attributed to any task. That gap is why the healer reported
 * `candidateCount: 0` while the task's real 1.8 MB transcript sat on disk, and
 * the task got reset instead of repointed. The bind (`bindSessionToTask`) records
 * the ownership this reads, so pooled and direct sessions are equally visible.
 */
export async function listResumeCandidates(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<string[]> {
  const rows = await db.all<{ conversation_id: string }>(
    `WITH reset AS (
       SELECT max(created_at) AS at
       FROM session_resets
       WHERE task_id = ? AND mode = ?
     )
     SELECT DISTINCT s.conversation_id AS conversation_id
       FROM agent_sessions s
       WHERE s.task_id = ? AND s.mode = ?
         AND ${ownedSessionSql('(SELECT at FROM reset)')}
       ORDER BY ${OWNED_AT_SQL} DESC`,
    [taskId, mode, taskId, mode]
  )
  return rows.map((r) => r.conversation_id)
}

/**
 * Is `conversationId` a session this task+mode actually owns and still has?
 *
 * The guard on every user-driven session action (switch, delete). It answers
 * "did slay record an honored session with this id, for THIS task and mode, that
 * has not been deleted?" — so a caller cannot launder a `foreign-observed` id, a
 * pending-spawn phantom, another task's conversation, or a tombstoned one into
 * the honored set by naming it in a `user-selected` write.
 */
export async function isHonoredConversation(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  conversationId: string
): Promise<boolean> {
  const row = await db.get<{ one: number }>(
    `SELECT 1 AS one
       FROM agent_sessions s
       WHERE s.task_id = ? AND s.mode = ? AND s.conversation_id = ?
         AND s.origin IN (${HONORED_ORIGINS_SQL})
         AND ${NOT_DELETED_SQL}
       LIMIT 1`,
    [taskId, mode, conversationId]
  )
  return !!row
}

/**
 * Tombstone one session so it disappears from the sidebar, from the task's
 * message history, and from every resume decision. The provider's own transcript
 * on disk is NOT touched — slay didn't write it and doesn't own it.
 *
 * Refuses (returns false) when the id is the task's CURRENT session: a live agent
 * process is running on that conversation, and hiding it would leave the running
 * terminal bound to a session the UI says no longer exists. Switch to another
 * session first, which makes this one non-current, then delete it.
 *
 * Idempotent — a second delete of the same session inserts a second tombstone,
 * which changes nothing (the exclusion is `NOT EXISTS`, not a count).
 */
export async function deleteSession(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  conversationId: string
): Promise<boolean> {
  const current = await getCurrentConversationId(db, taskId, mode)
  if (current === conversationId) return false
  await db.run(
    `INSERT INTO session_deletions (id, task_id, mode, conversation_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [randomUUID(), taskId, mode, conversationId, Date.now()]
  )
  agentSessionsEvents.emit('agent-sessions:changed', { taskId })
  return true
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

/** One user-facing agent session for a task: a distinct provider conversation. */
export interface TaskSessionSummary {
  /** Provider thread id — the session's stable identity. */
  conversationId: string
  /** Provenance of the session's first spawn (fresh / resume / heal / …). */
  origin: ConversationOrigin
  /** Earliest spawn timestamp for this conversation. */
  startedAt: number
  /** Latest spawn timestamp for this conversation (most recent re-spawn/resume). */
  lastActiveAt: number
  /** User prompts captured for this conversation (join on cli_session_id). */
  messageCount: number
  /** Earliest captured user prompt text — the human-readable session label. */
  firstPrompt: string | null
  /** True when this conversation is the honored "current" one (reset-aware). */
  isCurrent: boolean
}

/**
 * Every agent session tied to (taskId, mode), one entry per distinct
 * `conversation_id`, newest first. This is the user's mental model of a
 * "session": a `--resume` re-spawn reuses the same conversation and collapses
 * into one entry here (multiple `agent_sessions` rows → one session), while a
 * fresh start / reset mints a new conversation → a new entry.
 *
 * Only HONORED origins count as sessions the user actually started
 * (`HONORED_ORIGINS` — slay-spawned fresh/resume, an in-band `/clear`, a
 * conversation-id heal, and legacy backfill).
 * `pending-spawn` rows are excluded even though they carry the pre-minted
 * expected id — many belong to spawns that died before the agent confirmed a
 * SessionStart, so surfacing them would show phantom sessions. `foreign-observed`
 * is audit-only (a manual `--resume X`), never a session slay owns. Warm-pool
 * rows (null task), null-conversation rows, and user-deleted sessions
 * (`NOT_DELETED_SQL`) are excluded too.
 *
 * `messageCount` + `firstPrompt` join `agent_prompts` on
 * `cli_session_id = conversation_id` (they are the same value). `isCurrent`
 * mirrors `getCurrentConversationId` — the latest honored conversation strictly
 * after the most recent reset — so a reset leaves the history intact but marks
 * no session current.
 */
export async function listTaskSessions(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<TaskSessionSummary[]> {
  const current = await getCurrentConversationId(db, taskId, mode)
  const rows = await db.all<{
    conversation_id: string
    origin: ConversationOrigin
    started_at: number
    last_active_at: number
    message_count: number
    first_prompt: string | null
  }>(
    `SELECT
       s.conversation_id                         AS conversation_id,
       (SELECT o.origin FROM agent_sessions o
          WHERE o.task_id = s.task_id AND o.mode = s.mode
            AND o.conversation_id = s.conversation_id
            AND o.origin IN (${HONORED_ORIGINS_SQL})
          ORDER BY o.created_at ASC, o.rowid ASC LIMIT 1) AS origin,
       min(s.created_at)                         AS started_at,
       max(s.created_at)                         AS last_active_at,
       (SELECT count(*) FROM agent_prompts p
          WHERE p.task_id = s.task_id AND p.cli_session_id = s.conversation_id) AS message_count,
       (SELECT p.text FROM agent_prompts p
          WHERE p.task_id = s.task_id AND p.cli_session_id = s.conversation_id
          ORDER BY p.created_at ASC, p.rowid ASC LIMIT 1) AS first_prompt
     FROM agent_sessions s
     WHERE s.task_id = ? AND s.mode = ? AND s.conversation_id IS NOT NULL
       AND s.origin IN (${HONORED_ORIGINS_SQL})
       AND ${NOT_DELETED_SQL}
     GROUP BY s.conversation_id
     ORDER BY started_at DESC`,
    [taskId, mode]
  )
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    origin: r.origin,
    startedAt: r.started_at,
    lastActiveAt: r.last_active_at,
    messageCount: r.message_count,
    firstPrompt: r.first_prompt,
    isCurrent: r.conversation_id === current
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

/**
 * Does slay own the agent process that just reported `observedConversationId`
 * for (taskId, mode)? Answers the ONE question the `/clear` path needs and
 * nothing more.
 *
 * WHY THIS EXISTS ALONGSIDE `findPendingSpawn` — the two are not
 * interchangeable, and using the wrong one is the bug this closes:
 *
 *   `findPendingSpawn` answers "is a spawn IN FLIGHT right now?", so it applies a
 *   10-minute TTL. An agent's `/clear` happens whenever the user decides to —
 *   hours into a session is normal — and by then the TTL has long since hidden
 *   the row. The spawn-intent row itself is NOT deleted at the TTL (only
 *   `prunePendingSpawns` deletes, on PTY exit or sweep), so the ownership
 *   evidence is still on disk; only that reader refuses to see it.
 *
 *   This function asks the durable question instead: did slay record a spawn for
 *   this (task, mode) whose pre-minted id is the conversation the agent is
 *   REPLACING? A pre-minted id is passed to the provider on slay's own command
 *   line, so only a process slay launched can echo it back — matching it is
 *   proof of ownership that survives the id rotation.
 *
 * Deliberately NOT a general-purpose "was this ever ours" helper: it requires
 * the caller to name the outgoing conversation id, so a caller cannot use it to
 * launder an arbitrary foreign id into an honored one.
 *
 * Returns the runtime session id of the owning spawn row, or null.
 */
export async function findOwnedSpawnForConversation(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  /** The conversation the agent is rotating AWAY from (slay's current honored
   *  id for this task+mode). Null/empty → no ownership claim is possible. */
  outgoingConversationId: string | null
): Promise<string | null> {
  if (!outgoingConversationId) return null
  const row = await db.get<{ id: string }>(
    `SELECT id
       FROM agent_sessions
       WHERE task_id = ? AND mode = ?
         AND conversation_id = ?
         AND origin IN ('pending-spawn', ${HONORED_ORIGINS_SQL})
       ORDER BY created_at DESC
       LIMIT 1`,
    [taskId, mode, outgoingConversationId]
  )
  return row?.id ?? null
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
 * Record that a conversation has taken its first turn — i.e. the provider has
 * written its transcript and `--resume <id>` will now succeed. Write-once: the
 * mark means "has content", not "was last active", so a later turn must never
 * move it (that would make it a mtime, and every reader would start racing it).
 *
 * Keyed by `conversation_id` rather than the runtime session id, because that is
 * the only identifier a provider hook carries for BOTH a task-spawned agent and a
 * warm-pool one (whose env was fixed before any task existed — see
 * `getBoundTaskId`). Returns true if this call was the one that marked it.
 */
export async function markSessionFirstTurn(
  db: SlayzoneDb,
  conversationId: string
): Promise<boolean> {
  const res = await db.run(
    `INSERT OR IGNORE INTO session_turns (conversation_id, first_turn_at) VALUES (?, ?)`,
    [conversationId, Date.now()]
  )
  return res.changes > 0
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
    mode: string
  }>(
    `SELECT conversation_id, pending_meta, mode
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
  // Resumability proof for the cases that do not need a turn to be certain:
  //  - a RESUME proves itself — the provider just reopened that transcript;
  //  - a provider whose turns slay cannot observe has to be trusted at confirm,
  //    or its sessions could never be resumed at all.
  // Everything else — a fresh start of a turn-tracked provider — stays unproven
  // until `markSessionFirstTurn`. Confirm is the right seam because it is the
  // first moment the REAL conversation id is known (a pre-mint can be wrong, and
  // providers that mint their own id have none until here).
  if (usedResume || !TURN_TRACKED_MODES.has(await resolveTurnTrackedAgent(db, row.mode))) {
    await markSessionFirstTurn(db, args.observedConversationId)
  }
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
  await db.run(`UPDATE agent_sessions SET status = 'dead', ended_at = ? WHERE id = ?`, [
    Date.now(),
    sessionId
  ])
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
  if (res.changes > 0) {
    // A pooled session just became this task's session → refresh its history.
    agentSessionsEvents.emit('agent-sessions:changed', { taskId: args.taskId })
  }
  return res.changes > 0
}

/**
 * Resolve the task a (pool) session id is bound to, if any. A warm-pool agent's
 * env vars are fixed at process spawn (no `SLAYZONE_TASK_ID` — the task didn't
 * exist yet), so its hook payloads carry only `slaySessionId` forever; this is
 * how the hook route recovers the task id `bindSessionToTask` recorded here.
 * `bound_at IS NOT NULL` is the set-once bind marker (never reverts).
 */
export async function getBoundTaskId(db: SlayzoneDb, sessionId: string): Promise<string | null> {
  const row = await db.get<{ task_id: string | null }>(
    `SELECT task_id FROM agent_sessions WHERE id = ? AND bound_at IS NOT NULL`,
    [sessionId]
  )
  return row?.task_id ?? null
}
