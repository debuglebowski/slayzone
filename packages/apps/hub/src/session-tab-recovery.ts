import type { SlayzoneDb } from '@slayzone/platform'
import type { DiagnosticEvent } from '@slayzone/diagnostics/shared'
import type { ComputerSessionLedger } from '@slayzone/chat-runtime/hub'

/**
 * One-time recovery of terminal sessions that secondary tabs ran before sessions
 * were scoped per tab (robustness plan §2, migration v201).
 *
 * v201 backfilled every pre-existing session to the MAIN tab — exactly the old
 * behaviour, but wrong for a session a secondary agent tab actually ran. It
 * queued each conversation that COULD be such a session (`session_tab_recovery`:
 * its task has a non-main tab of the same mode). This job settles each from the
 * only evidence that exists: the diagnostics of the spawn that minted it.
 *
 * Attribution: a conversation's EARLIEST `agent_sessions` row is its minting
 * spawn. The spawn's `conv_id.spawn_decision` event (logged by `createPty` a
 * moment before that row, session id `taskId:tabId`) names the tab. Accepted only
 * when it is a fresh start (`resuming: false` — a resume says nothing about who
 * minted it), its `pty.create` ran that mode, exactly ONE tab matches within the
 * window, and that tab still exists in the task and is not the main tab. Any
 * doubt leaves the session on the main tab (= the pre-v201 behaviour, never
 * worse). Newer spawns also log `conv_id.spawn_effective` with the exact
 * conversation id, which is used first.
 *
 * Restore rule (decision 1, 2026-11-09): before v201 a reset of the MAIN tab cut
 * off every tab — a secondary tab's next spawn then minted a casualty session.
 * Those resets are main-only now, so the tab's own session is visible again;
 * this makes it the tab's CURRENT one regardless of what the casualty does (its
 * first turn, before or after this runs, would otherwise make it current): if,
 * after a main-scoped pre-v201 reset R, tab T minted fresh sessions, append an
 * honored repoint claim (`cas-repoint-heal`) in T of the session T would have
 * resumed just before R. The claim is newer than every casualty, so it stays
 * current until the user picks or resets. Casualties stay in the
 * history, switchable; nothing is deleted. For the incident: the "deploy" tab
 * resumes bf71421e, never 786b528e.
 *
 * The sessions live on the computer running the task's agents (robustness plan
 * §9, P0); the evidence and the work list stay on the hub. So the recovery runs per
 * task, against that computer, the first time the task is used there after its
 * sessions were handed over (`ComputerSessionLedger.prepare`) — before any resume
 * is decided. A task whose computer never connects keeps its rows.
 *
 * A queued row is deleted once tried — the evidence only shrinks (diagnostics
 * retention), so a later try could never know more — except when the diagnostics
 * store cannot be read, which keeps it for the next try (the error is thrown).
 * Without a diagnostics store at all nothing can ever be proven, so every row
 * settles on the main tab.
 */
export interface SessionTabRecovery {
  taskId: string
  retagged: Array<{ mode: string; conversationId: string; tabId: string }>
  restored: Array<{ mode: string; tabId: string; conversationId: string }>
}

/** Spawn window around a session's first row: the decision is logged just before it. */
const BEFORE_MS = 5_000
const AFTER_MS = 1_000

interface QueuedRow {
  task_id: string
  mode: string
  conversation_id: string
  backfilled_at: number
}

/** The ledger operations the recovery runs on the task's computer. */
export type TabRecoveryLedger = Pick<
  ComputerSessionLedger,
  | 'retagBackfilledSessionTab'
  | 'resumableSessionBefore'
  | 'freshSessionsOfTabBetween'
  | 'conversationMintedAt'
> & { store: Pick<ComputerSessionLedger['store'], 'recordConversation'> }

interface RecoveryDeps {
  db: SlayzoneDb
  /** The hub's diagnostics store; absent = no evidence can exist. */
  diagnostics: SlayzoneDb | null
  record: (event: DiagnosticEvent) => void
  ledger: TabRecoveryLedger
  computerId: string
}

/**
 * Recover one task's queued sessions on the computer holding them. No-op when none
 * are queued. Throws (keeping the rows) when the evidence or the computer could not
 * be read: the caller's start fails and retries.
 */
export async function recoverTaskSessionTabs(
  deps: RecoveryDeps,
  taskId: string
): Promise<SessionTabRecovery | null> {
  const rows = await deps.db.all<QueuedRow>(
    'SELECT task_id, mode, conversation_id, backfilled_at FROM session_tab_recovery WHERE task_id = ?',
    [taskId]
  )
  if (!rows.length) return null
  try {
    const result = await recoverTask(deps, taskId, rows)
    await deps.db.run('DELETE FROM session_tab_recovery WHERE task_id = ?', [taskId])
    return result
  } catch (err) {
    deps.record({
      level: 'warn',
      source: 'pty',
      event: 'session.tab_recovery_failed',
      taskId,
      message: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

async function recoverTask(
  deps: RecoveryDeps,
  taskId: string,
  rows: QueuedRow[]
): Promise<SessionTabRecovery> {
  const { db, ledger, computerId } = deps
  const result: SessionTabRecovery = { taskId, retagged: [], restored: [] }
  const secondaryTabs = new Set(
    (
      await db.all<{ id: string }>(
        'SELECT id FROM terminal_tabs WHERE task_id = ? AND is_main = 0',
        [taskId]
      )
    ).map((t) => t.id)
  )
  const upTo = Math.max(...rows.map((r) => r.backfilled_at))

  for (const row of rows) {
    if (!deps.diagnostics) continue
    const tabId = await evidencedTab(deps, taskId, row)
    if (!tabId || !secondaryTabs.has(tabId)) continue
    const moved = await ledger.retagBackfilledSessionTab(computerId, {
      taskId,
      mode: row.mode,
      conversationId: row.conversation_id,
      tabId,
      upTo: row.backfilled_at
    })
    if (!moved) continue
    result.retagged.push({ mode: row.mode, conversationId: row.conversation_id, tabId })
    deps.record({
      level: 'info',
      source: 'pty',
      event: 'session.tab_recovered',
      taskId,
      message: row.conversation_id,
      payload: { mode: row.mode, tabId, rows: moved }
    })
  }

  // The restore rule, per (secondary tab, mode) that got sessions back.
  const pairs = new Map(result.retagged.map((r) => [`${r.tabId}\u0000${r.mode}`, r]))
  for (const { tabId, mode } of pairs.values()) {
    const reset = await db.get<{ at: number | null }>(
      `SELECT max(created_at) AS at FROM session_resets
        WHERE task_id = ? AND (mode = ? OR mode = '*') AND tab_id = task_id AND created_at <= ?`,
      [taskId, mode, upTo]
    )
    if (!reset?.at) continue
    const before = await ledger.resumableSessionBefore(computerId, {
      taskId,
      mode,
      tabId,
      at: reset.at
    })
    if (!before) continue
    const casualties = await ledger.freshSessionsOfTabBetween(computerId, {
      taskId,
      mode,
      tabId,
      from: reset.at,
      to: upTo
    })
    if (!casualties.some((c) => c !== before)) continue
    // Always the claim, even when `before` already reads as current: that can be
    // only because the casualty has no turn YET — its first turn would make it
    // current. The claim is newer than any casualty, so it never can.
    await ledger.store.recordConversation(computerId, {
      taskId,
      mode,
      tabId,
      conversationId: before,
      origin: 'cas-repoint-heal'
    })
    result.restored.push({ mode, tabId, conversationId: before })
    deps.record({
      level: 'info',
      source: 'pty',
      event: 'session.tab_restored',
      taskId,
      message: before,
      payload: { mode, tabId, resetAt: reset.at, casualties }
    })
  }
  return result
}

/**
 * The secondary tab whose spawn minted `row.conversation_id`, proven by
 * diagnostics, or null. Throws when the diagnostics store cannot be read (the
 * caller keeps the row for the next boot).
 */
async function evidencedTab(
  deps: RecoveryDeps,
  taskId: string,
  row: QueuedRow
): Promise<string | null> {
  const diagnostics = deps.diagnostics!
  const prefix = `${taskId}:`
  const tabOf = (sessionId: string | null): string | null =>
    sessionId?.startsWith(prefix) ? sessionId.slice(prefix.length) || null : null

  // Exact: newer spawns log the conversation they run.
  const exact = await diagnostics.all<{ session_id: string | null; payload_json: string | null }>(
    `SELECT session_id, payload_json FROM diagnostics_events
      WHERE event = 'conv_id.spawn_effective' AND task_id = ? AND message = ?
      ORDER BY ts_ms ASC LIMIT 1`,
    [taskId, row.conversation_id]
  )
  const exactTab = exact[0] ? tabOf(exact[0].session_id) : null
  if (exactTab) return exactTab

  // The minting spawn: the conversation's earliest row of this task and mode.
  const firstAt = await deps.ledger.conversationMintedAt(deps.computerId, {
    taskId,
    mode: row.mode,
    conversationId: row.conversation_id
  })
  if (!firstAt) return null
  const decisions = await diagnostics.all<{
    session_id: string | null
    ts_ms: number
    payload_json: string | null
  }>(
    `SELECT session_id, ts_ms, payload_json FROM diagnostics_events
      WHERE event = 'conv_id.spawn_decision' AND task_id = ? AND ts_ms BETWEEN ? AND ?`,
    [taskId, firstAt - BEFORE_MS, firstAt + AFTER_MS]
  )
  const tabs = new Set<string>()
  for (const d of decisions) {
    const tab = tabOf(d.session_id)
    if (!tab) continue
    const payload = parse(d.payload_json)
    if (payload?.resuming !== false) continue
    // The spawn ran THIS mode (its pty.create, same session, same moment).
    const create = await diagnostics.get<{ payload_json: string | null }>(
      `SELECT payload_json FROM diagnostics_events
        WHERE event = 'pty.create' AND session_id = ? AND ts_ms BETWEEN ? AND ?
        ORDER BY abs(ts_ms - ?) LIMIT 1`,
      [d.session_id, d.ts_ms - AFTER_MS, d.ts_ms + AFTER_MS, d.ts_ms]
    )
    if (parse(create?.payload_json ?? null)?.mode !== row.mode) continue
    tabs.add(tab)
  }
  return tabs.size === 1 ? [...tabs][0] : null
}

function parse(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
