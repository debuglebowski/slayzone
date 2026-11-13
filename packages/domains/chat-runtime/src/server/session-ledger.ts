import { randomUUID } from 'node:crypto'
import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import {
  type ConversationOrigin,
  HONORED_ORIGINS,
  HONORED_ORIGINS_SQL
} from '@slayzone/task-contracts'
import { isBuiltinAgentId, isChatSupported, modeAgentId } from '@slayzone/terminal-contracts'

/**
 * The agent-session ledger (robustness plan §9, P0): which provider conversations a
 * task's agents ran, per (task, mode, TAB), and which one each tab resumes next.
 *
 * It lives ONLY on the computer that runs the agents — in its chat store
 * (`chat.sqlite`, schema v7) — because nothing else uses it: the transcripts it
 * points at are on that computer's disk. The hub keeps no copy. What the hub keeps
 * is the USER'S INTENT about sessions (`session_resets`, `session_deletions`): it
 * delivers those rows to every computer of the task, which stores them under the
 * same names, so every rule below reads them as plain tables.
 *
 * Tables (computer):
 *  - `agent_sessions`: one row per spawn (or per honored ledger append). Warm-pool
 *    members are rows with `status='pooled'` and no task until adopted (bound).
 *  - `task_conversations`: the append-only provenance trail (audit + resets).
 *  - `session_turns`: the resumability proof (first turn taken).
 *  - `session_resets`, `session_deletions`: the hub's intent, as delivered.
 *  - `mode_agents`: which agent a user-defined mode wraps (turn tracking).
 *
 * Every rule is structural SQL — the reset cutoff, deletions, one task per provider
 * session, one owner tab per conversation — never a JS post-filter a caller could
 * forget. Moved verbatim (semantics) from the hub's task domain; see the comments
 * there in git history for the incidents behind each rule.
 *
 * @module chat-runtime/server/session-ledger
 */

/** Correlated exclusion of user-deleted sessions (`session_deletions` tombstones). */
function notDeletedSql(alias: string): string {
  return `NOT EXISTS (
       SELECT 1 FROM session_deletions d
        WHERE d.task_id = ${alias}.task_id
          AND d.mode = ${alias}.mode
          AND d.conversation_id = ${alias}.conversation_id
     )`
}
const NOT_DELETED_SQL = notDeletedSql('s')

/**
 * When a session became THIS task's: its adoption for a warm-pool agent, else its
 * spawn. Every ordering and reset cutoff uses this, never raw `created_at`.
 */
export const OWNED_AT_SQL = `coalesce(s.bound_at, s.created_at)`

/** A task's CLAIM on a provider session: an honored, undeleted row naming it. */
function claimSql(alias: string): string {
  return `${alias}.task_id IS NOT NULL
         AND ${alias}.conversation_id IS NOT NULL
         AND ${alias}.origin IN (${HONORED_ORIGINS_SQL})
         AND ${notDeletedSql(alias)}`
}

/** When task `taskExpr` first claimed `convExpr` (min owned-at), or NULL. */
function firstClaimSql(taskExpr: string, convExpr: string): string {
  return `(SELECT min(coalesce(m.bound_at, m.created_at)) FROM agent_sessions m
          WHERE m.task_id = ${taskExpr} AND m.conversation_id = ${convExpr}
            AND ${claimSql('m')})`
}

/**
 * One task per provider session: the task that claimed it FIRST (ties: lower task
 * id). Any other task's claim is not its session. Correlated NOT EXISTS for a row
 * aliased `s`.
 */
const NOT_CLAIMED_ELSEWHERE_SQL = `NOT EXISTS (
       SELECT 1 FROM agent_sessions o
        WHERE o.conversation_id = s.conversation_id
          AND o.task_id <> s.task_id
          AND ${claimSql('o')}
          AND (coalesce(o.bound_at, o.created_at), o.task_id)
              < (${firstClaimSql('s.task_id', 's.conversation_id')}, s.task_id)
     )`

/** The resumability proof (first turn taken) for a row aliased `s`. */
const HAS_TURN_SQL = `EXISTS (
       SELECT 1 FROM session_turns t
        WHERE t.conversation_id = s.conversation_id
     )`

/** THE definition of "a session this tab can resume" (row aliased `s`). */
export function resumableSessionSql(resetAtExpr: string, tabExpr: string): string {
  return `${ownedSessionSql(resetAtExpr, tabExpr)}
         AND ${HAS_TURN_SQL}`
}

/** Ownership without the resumability proof (the healer's candidate base). */
export function ownedSessionSql(resetAtExpr: string, tabExpr: string): string {
  return `s.conversation_id IS NOT NULL
         AND s.origin IN (${HONORED_ORIGINS_SQL})
         AND ${OWNED_AT_SQL} > coalesce(${resetAtExpr}, 0)
         AND ${NOT_DELETED_SQL}
         AND ${NOT_CLAIMED_ELSEWHERE_SQL}
         AND ${ownedByTabSql(tabExpr)}`
}

/** The tab a row belongs to (no tab = the main tab, whose id is the task id). */
export function sessionTabSql(alias: string): string {
  return `coalesce(${alias}.tab_id, ${alias}.task_id)`
}

/**
 * A session belongs to tab `tabExpr`: its row is that tab's, and no LATER claim of
 * the same conversation in this task sits in another tab (one owner tab — a pick
 * moves it). Row aliased `s`.
 */
function ownedByTabSql(tabExpr: string): string {
  return `${sessionTabSql('s')} = ${tabExpr}
         AND NOT EXISTS (
           SELECT 1 FROM agent_sessions x
            WHERE x.task_id = s.task_id
              AND x.conversation_id = s.conversation_id
              AND ${sessionTabSql('x')} <> ${sessionTabSql('s')}
              AND ${claimSql('x')}
              AND (coalesce(x.bound_at, x.created_at), x.rowid) > (${OWNED_AT_SQL}, s.rowid)
         )`
}

/**
 * The reset cutoff of (task, mode, tab): a scalar subquery over bound parameters
 * `?, ?, ?, ?` = (task, mode, mode-is-chat 0/1, tab) — see {@link resetParams}.
 *
 * A reset names its tab, or none (a whole-task reset). It names its mode, or `*`
 * (every mode — a reset the hub recorded without asking which modes have sessions,
 * so it works with the computer offline; `except_chat` = every mode but the chat
 * modes, the main-agent switch). A reset of ANOTHER tab never cuts this one.
 */
export const TAB_RESET_AT_SQL = `(SELECT max(created_at) FROM session_resets
       WHERE task_id = ?
         AND (mode = ? OR (mode = '*' AND (except_chat = 0 OR ? = 0)))
         AND (tab_id = ? OR tab_id IS NULL))`

/** Bound parameters of {@link TAB_RESET_AT_SQL}. */
export function resetParams(taskId: string, mode: string, tabId: string): unknown[] {
  return [taskId, mode, isChatSupported(mode) ? 1 : 0, tabId]
}

/** Agents whose first turn slay can observe (their hooks post `UserPromptSubmit`). */
export const TURN_TRACKED_AGENTS: ReadonlySet<string> = new Set(['claude-code'])

/**
 * Whether a session of `mode` must wait for its first turn to be proven resumable:
 * whether the AGENT the mode runs is turn-tracked. A user-defined mode's agent comes
 * from `mode_agents` (the hub names it with every ledger call).
 */
export async function isTurnTrackedMode(db: SlayzoneDb, mode: string): Promise<boolean> {
  const declaredType = isBuiltinAgentId(mode)
    ? null
    : (
        await db.get<{ agent_type: string | null }>(
          'SELECT agent_type FROM mode_agents WHERE mode = ?',
          [mode]
        )
      )?.agent_type
  return TURN_TRACKED_AGENTS.has(modeAgentId(mode, declaredType))
}

/** Remember which agent user-defined modes wrap (built-ins are their own agent). */
export async function noteModeAgents(
  db: SlayzoneDb,
  modes: Readonly<Record<string, string | null>>
): Promise<void> {
  for (const [mode, type] of Object.entries(modes)) {
    if (isBuiltinAgentId(mode)) continue
    await db.run(
      `INSERT INTO mode_agents(mode, agent_type) VALUES(?, ?)
       ON CONFLICT(mode) DO UPDATE SET agent_type = excluded.agent_type`,
      [mode, type]
    )
  }
}

const TTL_PENDING_MS = 10 * 60 * 1000
const TTL_PENDING_NULL_EXPECTED_MS = 30 * 1000
const FIND_PENDING_RETRY_MS = 100

/** The conversation tab `tabId` (default: main) of (task, mode) resumes next, or null. */
export async function getCurrentConversationId(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  tabId: string = taskId
): Promise<string | null> {
  const row = await db.get<{ conversation_id: string | null }>(
    `WITH reset AS (SELECT ${TAB_RESET_AT_SQL} AS at)
     SELECT s.conversation_id AS conversation_id
       FROM agent_sessions s
       WHERE s.task_id = ? AND s.mode = ?
         AND ${resumableSessionSql('(SELECT at FROM reset)', '?')}
       ORDER BY ${OWNED_AT_SQL} DESC
       LIMIT 1`,
    [...resetParams(taskId, mode, tabId), taskId, mode, tabId]
  )
  return row?.conversation_id ?? null
}

/** Every conversation the tab could legitimately fall back to, newest-owned first. */
export async function listResumeCandidates(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  tabId: string = taskId
): Promise<string[]> {
  const rows = await db.all<{ conversation_id: string }>(
    `WITH reset AS (SELECT ${TAB_RESET_AT_SQL} AS at)
     SELECT DISTINCT s.conversation_id AS conversation_id
       FROM agent_sessions s
       WHERE s.task_id = ? AND s.mode = ?
         AND ${ownedSessionSql('(SELECT at FROM reset)', '?')}
       ORDER BY ${OWNED_AT_SQL} DESC`,
    [...resetParams(taskId, mode, tabId), taskId, mode, tabId]
  )
  return rows.map((r) => r.conversation_id)
}

/** When slay first recorded `conversationId` (spawn time, any task), or null. */
export async function getConversationFirstSeenAt(
  db: SlayzoneDb,
  conversationId: string
): Promise<number | null> {
  const row = await db.get<{ at: number | null }>(
    `SELECT min(created_at) AS at FROM agent_sessions WHERE conversation_id = ?`,
    [conversationId]
  )
  return row?.at ?? null
}

/** Is `conversationId` a session this task+mode owns and still has? (anti-laundering guard) */
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
         AND ${NOT_CLAIMED_ELSEWHERE_SQL}
       LIMIT 1`,
    [taskId, mode, conversationId]
  )
  return !!row
}

/** The tabs of `taskId` whose CURRENT `mode` session is `conversationId` (at most one). */
export async function currentTabsOf(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  conversationId: string
): Promise<string[]> {
  const tabs = await db.all<{ tab: string }>(
    `SELECT DISTINCT ${sessionTabSql('s')} AS tab FROM agent_sessions s
      WHERE s.task_id = ? AND s.mode = ? AND s.conversation_id = ?`,
    [taskId, mode, conversationId]
  )
  const out: string[] = []
  for (const { tab } of tabs)
    if ((await getCurrentConversationId(db, taskId, mode, tab)) === conversationId) out.push(tab)
  return out
}

/**
 * Whether the user may delete this session: an honored session of the task that is
 * no tab's CURRENT one (a live agent runs it, or resumes it next).
 */
export async function deletableSession(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  conversationId: string
): Promise<'ok' | 'not-honored' | 'current'> {
  if (!(await isHonoredConversation(db, taskId, mode, conversationId))) return 'not-honored'
  if ((await currentTabsOf(db, taskId, mode, conversationId)).length) return 'current'
  return 'ok'
}

/** Of `conversationIds`, those that are ANOTHER task's session for `taskId`. */
export async function claimedByOtherTasks(
  db: SlayzoneDb,
  taskId: string,
  conversationIds: string[]
): Promise<Set<string>> {
  if (!conversationIds.length) return new Set()
  const placeholders = conversationIds.map(() => '?').join(',')
  const rows = await db.all<{ conversation_id: string }>(
    `SELECT DISTINCT o.conversation_id AS conversation_id
       FROM agent_sessions o
      WHERE o.conversation_id IN (${placeholders})
        AND o.task_id <> ?
        AND ${claimSql('o')}
        AND (coalesce(o.bound_at, o.created_at), o.task_id)
            < (coalesce(${firstClaimSql('?', 'o.conversation_id')}, 9223372036854775807), ?)`,
    [...conversationIds, taskId, taskId, taskId]
  )
  return new Set(rows.map((r) => r.conversation_id))
}

/** One task's claim on a shared provider session, per mode. */
export interface SharedSessionClaim {
  taskId: string
  mode: string
  firstClaimAt: number
}

/** Every provider session claimed by more than one task, each (task, mode) claim earliest first. */
export async function listSharedSessionClaims(
  db: SlayzoneDb
): Promise<Array<{ conversationId: string; claims: SharedSessionClaim[] }>> {
  const rows = await db.all<{
    conversation_id: string
    task_id: string
    mode: string
    first_at: number
  }>(
    `WITH claims AS (
       SELECT s.conversation_id, s.task_id, s.mode, min(${OWNED_AT_SQL}) AS first_at
         FROM agent_sessions s
        WHERE ${claimSql('s')}
        GROUP BY s.conversation_id, s.task_id, s.mode
     ),
     shared AS (
       SELECT conversation_id FROM claims GROUP BY conversation_id HAVING count(DISTINCT task_id) > 1
     )
     SELECT c.conversation_id, c.task_id, c.mode, c.first_at
       FROM claims c JOIN shared USING (conversation_id)
      ORDER BY c.conversation_id, c.first_at, c.task_id, c.mode`
  )
  const out: Array<{ conversationId: string; claims: SharedSessionClaim[] }> = []
  for (const r of rows) {
    let entry = out[out.length - 1]
    if (!entry || entry.conversationId !== r.conversation_id) {
      entry = { conversationId: r.conversation_id, claims: [] }
      out.push(entry)
    }
    entry.claims.push({ taskId: r.task_id, mode: r.mode, firstClaimAt: r.first_at })
  }
  return out
}

/** Full audit trail of spawns for (taskId, mode), newest first. */
export async function listConversationHistory(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<
  Array<{ conversationId: string | null; origin: ConversationOrigin; createdAt: number }>
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
 * One user-facing session of a task (a distinct provider conversation), WITHOUT its
 * prompt summary — the hub adds that from wherever the prompts live.
 */
export interface TaskSessionRow {
  conversationId: string
  origin: ConversationOrigin
  startedAt: number
  lastActiveAt: number
  ownerTabId: string
  currentInOtherTab: boolean
  isCurrent: boolean
}

/** Every honored, undeleted session of (task, mode), newest first; `isCurrent` = `tabId`'s. */
export async function listTaskSessionRows(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  tabId: string = taskId
): Promise<TaskSessionRow[]> {
  const current = await getCurrentConversationId(db, taskId, mode, tabId)
  const otherTabs = await db.all<{ tab: string }>(
    `SELECT DISTINCT ${sessionTabSql('s')} AS tab FROM agent_sessions s
      WHERE s.task_id = ? AND s.mode = ? AND ${sessionTabSql('s')} <> ?`,
    [taskId, mode, tabId]
  )
  const currentElsewhere = new Set<string>()
  for (const { tab } of otherTabs) {
    const id = await getCurrentConversationId(db, taskId, mode, tab)
    if (id) currentElsewhere.add(id)
  }
  const rows = await db.all<{
    conversation_id: string
    origin: ConversationOrigin
    started_at: number
    last_active_at: number
    owner_tab_id: string
  }>(
    `SELECT
       s.conversation_id                         AS conversation_id,
       (SELECT ${sessionTabSql('w')} FROM agent_sessions w
          WHERE w.task_id = s.task_id AND w.conversation_id = s.conversation_id
            AND ${claimSql('w')}
          ORDER BY coalesce(w.bound_at, w.created_at) DESC, w.rowid DESC LIMIT 1) AS owner_tab_id,
       (SELECT o.origin FROM agent_sessions o
          WHERE o.task_id = s.task_id AND o.mode = s.mode
            AND o.conversation_id = s.conversation_id
            AND o.origin IN (${HONORED_ORIGINS_SQL})
          ORDER BY o.created_at ASC, o.rowid ASC LIMIT 1) AS origin,
       min(s.created_at)                         AS started_at,
       max(s.created_at)                         AS last_active_at
     FROM agent_sessions s
     WHERE s.task_id = ? AND s.mode = ? AND s.conversation_id IS NOT NULL
       AND s.origin IN (${HONORED_ORIGINS_SQL})
       AND ${NOT_DELETED_SQL}
       AND ${NOT_CLAIMED_ELSEWHERE_SQL}
     GROUP BY s.conversation_id
     ORDER BY started_at DESC`,
    [taskId, mode]
  )
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    origin: r.origin,
    startedAt: r.started_at,
    lastActiveAt: r.last_active_at,
    ownerTabId: r.owner_tab_id,
    currentInOtherTab: currentElsewhere.has(r.conversation_id),
    isCurrent: r.conversation_id === current
  }))
}

/** The modes with a session or ledger row in scope (one tab, or `null` = every tab). */
export async function sessionModesInScope(
  db: SlayzoneDb,
  taskId: string,
  tabId: string | null
): Promise<string[]> {
  const rows = await db.all<{ mode: string }>(
    `SELECT mode FROM agent_sessions
      WHERE task_id = ? AND (? IS NULL OR coalesce(tab_id, task_id) = ?)
     UNION
     SELECT mode FROM task_conversations
      WHERE task_id = ? AND (? IS NULL OR coalesce(tab_id, task_id) = ?)`,
    [taskId, tabId, tabId, taskId, tabId, tabId]
  )
  return rows.map((r) => r.mode)
}

/** The still-pending spawn for (taskId, mode): by launch token, else the newest in its window. */
export async function findPendingSpawn(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  who: { spawnToken?: string; tabId?: string } = {}
): Promise<{
  sessionId: string
  tabId: string
  expectedSessionId: string | null
  usedResume: boolean
  spawnedAt: number
  spawnToken?: string
} | null> {
  const cutoffExpected = Date.now() - TTL_PENDING_MS
  const cutoffNull = Date.now() - TTL_PENDING_NULL_EXPECTED_MS
  type Row = {
    id: string
    tab_id: string
    conversation_id: string | null
    pending_meta: string | null
  }
  const query = async (): Promise<Row | null> => {
    if (who.spawnToken) {
      // A token names one launch: never hand this hook another launch's row.
      return (
        (await db.get<Row>(
          `SELECT id, ${sessionTabSql('s')} AS tab_id, conversation_id, pending_meta
             FROM agent_sessions s
             WHERE task_id = ? AND mode = ? AND origin = 'pending-spawn'
               AND status != 'dead'
               AND json_extract(pending_meta, '$.spawnToken') = ?
             ORDER BY created_at DESC
             LIMIT 1`,
          [taskId, mode, who.spawnToken]
        )) ?? null
      )
    }
    return (
      (await db.get<Row>(
        `SELECT id, ${sessionTabSql('s')} AS tab_id, conversation_id, pending_meta
           FROM agent_sessions s
           WHERE task_id = ? AND mode = ? AND origin = 'pending-spawn'
             AND status != 'dead'
             AND (? IS NULL OR ${sessionTabSql('s')} = ?)
             AND (
               (conversation_id IS NOT NULL AND created_at >= ?)
               OR (conversation_id IS NULL AND
                 (created_at >= ? OR json_extract(pending_meta, '$.spawnToken') IS NOT NULL))
             )
           ORDER BY created_at DESC
           LIMIT 1`,
        [taskId, mode, who.tabId ?? null, who.tabId ?? null, cutoffExpected, cutoffNull]
      )) ?? null
    )
  }
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
      spawnToken?: string
    }
    return {
      sessionId: row.id,
      tabId: row.tab_id,
      expectedSessionId: row.conversation_id,
      usedResume: meta.usedResume,
      spawnedAt: meta.spawnedAt,
      spawnToken: meta.spawnToken
    }
  } catch {
    return null
  }
}

/**
 * Does slay own the process that is rotating AWAY from `outgoingConversationId`
 * (`/clear`)? Durable: a pre-minted id only slay's own command line introduced.
 */
export async function findOwnedSpawnForConversation(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
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

function resolveSpawnOrigin(
  expectedConversationId: string | null,
  observedConversationId: string,
  usedResume: boolean
): ConversationOrigin {
  if (expectedConversationId === null) return 'slay-spawned-fresh'
  if (observedConversationId === expectedConversationId)
    return usedResume ? 'slay-spawned-resume' : 'slay-spawned-fresh'
  return 'foreign-observed'
}

/** Insert the session row at spawn (`pending-spawn`; confirmed write-once later). */
export async function recordSessionSpawn(
  db: SlayzoneDb,
  args: {
    id: string
    taskId: string | null
    tabId: string | null
    mode: string
    cwd: string | null
    expectedConversationId: string | null
    usedResume: boolean
    spawnToken?: string
    status: 'pooled' | 'bound'
  }
): Promise<void> {
  const createdAt = Date.now()
  const meta = JSON.stringify({
    usedResume: args.usedResume,
    spawnedAt: createdAt,
    ...(args.spawnToken ? { spawnToken: args.spawnToken } : {})
  })
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

/** A conversation took its first turn (write-once). Returns whether this call marked it. */
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

/** Write-once confirm of the provider id for the spawn keyed by runtime `sessionId`. */
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
    if (row.pending_meta)
      usedResume = (JSON.parse(row.pending_meta) as { usedResume: boolean }).usedResume
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
  // A resume proves itself; a provider whose turns slay cannot observe is trusted
  // at confirm. A fresh turn-tracked start waits for its first turn.
  if (usedResume || !(await isTurnTrackedMode(db, row.mode)))
    await markSessionFirstTurn(db, args.observedConversationId)
  return origin
}

/** Mark a session's process exited. */
export async function markSessionDead(db: SlayzoneDb, sessionId: string): Promise<void> {
  await db.run(`UPDATE agent_sessions SET status = 'dead', ended_at = ? WHERE id = ?`, [
    Date.now(),
    sessionId
  ])
}

/** Bind a `pooled` session to a task+tab, set-once. */
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

/** A computer (re)started: no pooled process survived it. */
export async function retireDeadPool(db: SlayzoneDb): Promise<number> {
  const res = await db.run(
    `UPDATE agent_sessions SET status = 'dead', ended_at = ?
      WHERE status = 'pooled'`,
    [Date.now()]
  )
  return res.changes
}

/** Input of {@link recordConversation}. */
export interface RecordConversationInput {
  /** Stable identity (and time) when replaying an existing row. */
  id?: string
  createdAt?: number
  taskId: string
  mode: string
  /** The tab whose session this is; omitted = the main tab (id = task id). */
  tabId?: string
  conversationId: string | null
  origin: ConversationOrigin
  pendingMeta?: { usedResume: boolean; spawnedAt: number; spawnToken?: string }
}

/**
 * Append one ledger row: the provenance trail (`task_conversations`) and its
 * session row (`agent_sessions`), plus the resumability proof when the row proves
 * itself. A `manual-reset` is a `session_resets` event, not a session. Idempotent by
 * `id`; a conflicting replay of an id throws.
 */
export async function recordConversation(
  db: SlayzoneDb,
  args: RecordConversationInput
): Promise<void> {
  const { taskId, mode, conversationId, origin, pendingMeta } = args
  const tabId = args.tabId ?? taskId
  const id = args.id ?? randomUUID()
  const createdAt = args.createdAt ?? Date.now()
  if (!Number.isSafeInteger(createdAt) || createdAt < 0)
    throw new Error('Invalid conversation timestamp')
  if (args.id) {
    const existing = await db.get<{
      task_id: string
      mode: string
      conversation_id: string | null
      origin: string
    }>('SELECT task_id,mode,conversation_id,origin FROM task_conversations WHERE id=?', [id])
    if (
      existing &&
      (existing.task_id !== taskId ||
        existing.mode !== mode ||
        existing.conversation_id !== conversationId ||
        existing.origin !== origin)
    )
      throw new Error('Conversation ledger identity conflict')
  }
  const meta = origin === 'pending-spawn' && pendingMeta ? JSON.stringify(pendingMeta) : null
  const ops: BatchOp[] = [
    {
      type: 'run',
      sql: `INSERT INTO task_conversations
              (id, task_id, mode, tab_id, conversation_id, origin, pending_meta, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      params: [id, taskId, mode, tabId, conversationId, origin, meta, createdAt]
    }
  ]
  if (origin === 'manual-reset') {
    ops.push({
      type: 'run',
      sql: `INSERT INTO session_resets (id, task_id, mode, tab_id, except_chat, created_at)
            VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING`,
      params: [id, taskId, mode, tabId, createdAt]
    })
  } else {
    // An in-flight spawn stays findable (`status != 'dead'`); every other row is
    // a confirmed / historical one.
    const status = origin === 'pending-spawn' ? 'bound' : 'dead'
    // Proven at write unless it is a fresh start of a turn-tracked agent (its id is
    // reported before any transcript exists).
    const provenAtWrite = !(origin === 'slay-spawned-fresh' && (await isTurnTrackedMode(db, mode)))
    ops.push({
      type: 'run',
      sql: `INSERT INTO agent_sessions
              (id, mode, cwd, task_id, tab_id, conversation_id, origin, status, pending_meta, created_at, bound_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      params: [id, mode, taskId, tabId, conversationId, origin, status, meta, createdAt, createdAt]
    })
    if (origin !== 'pending-spawn' && conversationId && provenAtWrite) {
      ops.push({
        type: 'run',
        sql: `INSERT OR IGNORE INTO session_turns (conversation_id, first_turn_at) VALUES (?, ?)`,
        params: [conversationId, createdAt]
      })
    }
  }
  await db.batchTxn(ops)
}

/** Spawn-time provenance anchor; MUST complete before the agent starts. Returns its id. */
export async function recordPendingSpawn(
  db: SlayzoneDb,
  args: {
    taskId: string
    mode: string
    tabId?: string
    expectedSessionId: string | null
    usedResume: boolean
    spawnToken?: string
  }
): Promise<string> {
  const id = randomUUID()
  await recordConversation(db, {
    id,
    taskId: args.taskId,
    mode: args.mode,
    tabId: args.tabId,
    conversationId: args.expectedSessionId,
    origin: 'pending-spawn',
    pendingMeta: {
      usedResume: args.usedResume,
      spawnedAt: Date.now(),
      ...(args.spawnToken ? { spawnToken: args.spawnToken } : {})
    }
  })
  return id
}

/** Drop pending-spawn rows of one exiting PTY by id, or sweep stale token-less ones. */
export async function prunePendingSpawns(
  db: SlayzoneDb,
  scope?: { ids: string[] }
): Promise<number> {
  if (scope) {
    if (!scope.ids.length) return 0
    const ids = JSON.stringify(scope.ids)
    const res = await db.run(
      `DELETE FROM task_conversations
         WHERE origin = 'pending-spawn' AND id IN (SELECT value FROM json_each(?))`,
      [ids]
    )
    await db.run(
      `DELETE FROM agent_sessions
         WHERE origin = 'pending-spawn' AND id IN (SELECT value FROM json_each(?))`,
      [ids]
    )
    return res.changes
  }
  const cutoff = Date.now() - TTL_PENDING_MS
  const res = await db.run(
    `DELETE FROM task_conversations
       WHERE origin = 'pending-spawn' AND created_at < ?
         AND json_extract(pending_meta, '$.spawnToken') IS NULL`,
    [cutoff]
  )
  await db.run(
    `DELETE FROM agent_sessions
       WHERE origin = 'pending-spawn' AND created_at < ?
         AND json_extract(pending_meta, '$.spawnToken') IS NULL`,
    [cutoff]
  )
  return res.changes
}

// ── Hook effects ────────────────────────────────────────────────────────────────

/**
 * An agent's SessionStart reported `sessionId` for (task, mode): record it with its
 * provenance. The spawn's launch token names its pending row (and so its tab);
 * `source: 'clear'` with a provably slay-owned outgoing session is an in-band
 * rotation (`in-band-clear`); a mismatch is `foreign-observed` (audit only).
 * Returns what changed for the caller to report, or null when nothing did.
 */
export async function recordHookConversation(
  db: SlayzoneDb,
  args: {
    taskId: string
    mode: string
    sessionId: string
    source?: string
    spawnToken?: string
    /** The hook context's tab, when it is a tab of the task (the hub checks). */
    ctxTabId?: string
  }
): Promise<{ origin: ConversationOrigin; tabId: string } | null> {
  const { taskId, mode, sessionId, source, spawnToken } = args
  const pending = await findPendingSpawn(db, taskId, mode, {
    spawnToken,
    tabId: args.ctxTabId
  })
  const tabId = pending?.tabId ?? args.ctxTabId ?? taskId
  if (source === 'clear') {
    const outgoing = await getCurrentConversationId(db, taskId, mode, tabId)
    if (outgoing === sessionId) return null
    const owned = outgoing ? await findOwnedSpawnForConversation(db, taskId, mode, outgoing) : null
    if (owned) {
      await recordConversation(db, {
        taskId,
        mode,
        tabId,
        conversationId: sessionId,
        origin: 'in-band-clear'
      })
      return { origin: 'in-band-clear', tabId }
    }
  }
  const currentId =
    pending?.expectedSessionId === null
      ? await getCurrentConversationId(db, taskId, mode, tabId)
      : null
  if (currentId === sessionId) return null
  const freshSpawnMatches =
    pending?.expectedSessionId === null &&
    (!pending.spawnToken || pending.spawnToken === spawnToken)
  const origin: ConversationOrigin = !pending
    ? 'foreign-observed'
    : pending.expectedSessionId === null
      ? currentId || !freshSpawnMatches
        ? 'foreign-observed'
        : 'slay-spawned-fresh'
      : sessionId === pending.expectedSessionId
        ? pending.usedResume
          ? 'slay-spawned-resume'
          : 'slay-spawned-fresh'
        : 'foreign-observed'
  await recordConversation(db, { taskId, mode, tabId, conversationId: sessionId, origin })
  return { origin, tabId }
}

// ── Hub intent (resets, deletions) as delivered ─────────────────────────────────

/** One reset the hub recorded (user intent). `mode` `*` = every mode. */
export interface SessionResetIntent {
  id: string
  taskId: string
  mode: string
  tabId: string | null
  exceptChat: boolean
  createdAt: number
}

/** One deletion tombstone the hub recorded (user intent). */
export interface SessionDeletionIntent {
  id: string
  taskId: string
  mode: string
  conversationId: string
  createdAt: number
}

/** Store delivered intents (idempotent by id). */
export async function applySessionIntents(
  db: SlayzoneDb,
  intents: { resets: SessionResetIntent[]; deletions: SessionDeletionIntent[] }
): Promise<void> {
  const ops: BatchOp[] = []
  for (const r of intents.resets)
    ops.push({
      type: 'run',
      sql: `INSERT INTO session_resets (id, task_id, mode, tab_id, except_chat, created_at)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      params: [r.id, r.taskId, r.mode, r.tabId, r.exceptChat ? 1 : 0, r.createdAt]
    })
  for (const d of intents.deletions)
    ops.push({
      type: 'run',
      sql: `INSERT INTO session_deletions (id, task_id, mode, conversation_id, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      params: [d.id, d.taskId, d.mode, d.conversationId, d.createdAt]
    })
  if (ops.length) await db.batchTxn(ops)
}

// ── Legacy history (pre-ledger `provider_config.conversationHistory`) ───────────

/** The task's pre-ledger session list of `mode` (the main tab's), handed over by the hub. */
export async function legacyConversationHistory(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<string[]> {
  const row = await db.get<{ ids: string }>(
    'SELECT ids FROM legacy_conversation_history WHERE task_id = ? AND mode = ?',
    [taskId, mode]
  )
  if (!row) return []
  try {
    const ids = JSON.parse(row.ids) as unknown
    return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * Every conversation id any task here references (ledger + pre-ledger history): the
 * orphan heal never attaches a transcript one of them owns.
 */
export async function referencedConversationIds(db: SlayzoneDb): Promise<string[]> {
  const ids = new Set<string>()
  for (const r of await db.all<{ id: string }>(
    `SELECT conversation_id AS id FROM agent_sessions WHERE conversation_id IS NOT NULL
     UNION SELECT conversation_id FROM task_conversations WHERE conversation_id IS NOT NULL`
  ))
    ids.add(r.id)
  for (const r of await db.all<{ ids: string }>('SELECT ids FROM legacy_conversation_history')) {
    try {
      for (const id of JSON.parse(r.ids) as unknown[]) if (typeof id === 'string') ids.add(id)
    } catch {
      /* unreadable legacy list: nothing referenced */
    }
  }
  return [...ids]
}

// ── One-time session-tab recovery (v201 backfill) ───────────────────────────────

/** Move a conversation's pre-v201 main-tab rows of (task, mode) to `tabId`. */
export async function retagBackfilledSessionTab(
  db: SlayzoneDb,
  args: { taskId: string; mode: string; conversationId: string; tabId: string; upTo: number }
): Promise<number> {
  const { taskId, mode, conversationId, tabId, upTo } = args
  const [sessions] = (await db.batchTxn([
    {
      type: 'run',
      sql: `UPDATE agent_sessions SET tab_id = ?
             WHERE task_id = ? AND mode = ? AND conversation_id = ?
               AND coalesce(tab_id, task_id) = task_id AND created_at <= ?`,
      params: [tabId, taskId, mode, conversationId, upTo]
    },
    {
      type: 'run',
      sql: `UPDATE task_conversations SET tab_id = ?
             WHERE task_id = ? AND mode = ? AND conversation_id = ?
               AND coalesce(tab_id, task_id) = task_id AND created_at <= ?`,
      params: [tabId, taskId, mode, conversationId, upTo]
    }
  ])) as Array<{ changes: number }>
  return sessions?.changes ?? 0
}

/** The session tab `tabId` would have resumed at time `at`. */
export async function resumableSessionBefore(
  db: SlayzoneDb,
  args: { taskId: string; mode: string; tabId: string; at: number }
): Promise<string | null> {
  const { taskId, mode, tabId, at } = args
  const row = await db.get<{ conversation_id: string }>(
    `WITH reset AS (SELECT ${TAB_RESET_AT_SQL} AS at)
     SELECT s.conversation_id AS conversation_id
       FROM agent_sessions s
       WHERE s.task_id = ? AND s.mode = ?
         AND ${resumableSessionSql('(SELECT at FROM reset)', '?')}
         AND ${OWNED_AT_SQL} < ?
       ORDER BY ${OWNED_AT_SQL} DESC
       LIMIT 1`,
    [...resetParams(taskId, mode, tabId), taskId, mode, tabId, at]
  )
  return row?.conversation_id ?? null
}

/** Conversations tab `tabId` started fresh in, owned in (from, to]. */
export async function freshSessionsOfTabBetween(
  db: SlayzoneDb,
  args: { taskId: string; mode: string; tabId: string; from: number; to: number }
): Promise<string[]> {
  const rows = await db.all<{ conversation_id: string }>(
    `SELECT DISTINCT s.conversation_id AS conversation_id FROM agent_sessions s
      WHERE s.task_id = ? AND s.mode = ? AND ${sessionTabSql('s')} = ?
        AND s.origin = 'slay-spawned-fresh' AND s.conversation_id IS NOT NULL
        AND ${OWNED_AT_SQL} > ? AND ${OWNED_AT_SQL} <= ?`,
    [args.taskId, args.mode, args.tabId, args.from, args.to]
  )
  return rows.map((r) => r.conversation_id)
}

/** The earliest row of a conversation in (task, mode): its minting spawn's time. */
export async function conversationMintedAt(
  db: SlayzoneDb,
  args: { taskId: string; mode: string; conversationId: string }
): Promise<number | null> {
  const row = await db.get<{ at: number | null }>(
    `SELECT min(created_at) AS at FROM agent_sessions
      WHERE task_id = ? AND mode = ? AND conversation_id = ?`,
    [args.taskId, args.mode, args.conversationId]
  )
  return row?.at ?? null
}

/** Whether an origin makes a row a candidate for resumption (re-export for callers). */
export function isHonoredOrigin(origin: ConversationOrigin): boolean {
  return HONORED_ORIGINS.has(origin)
}
