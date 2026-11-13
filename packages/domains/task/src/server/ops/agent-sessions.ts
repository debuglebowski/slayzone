import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { legacyChatTables } from '@slayzone/platform/legacy-chat-tables'
import type { ConversationOrigin } from '@slayzone/task-contracts'
import type { TaskSessionStore } from '@slayzone/terminal/server'
import { isSyntheticChatPrompt } from '@slayzone/terminal-contracts'
import { agentSessionsEvents } from '../events'

/**
 * The hub's side of agent sessions (robustness plan §9, P0).
 *
 * The session ledger — which provider conversations a task's agents ran, per (task,
 * mode, tab), and which one each tab resumes — lives ONLY on the computer running
 * those agents (`@slayzone/chat-runtime` `session-ledger`). The hub keeps the user's
 * INTENT about sessions: resets (`session_resets`) and deletions
 * (`session_deletions`), delivered to every computer of the task. Everything here
 * either asks that computer through the injected {@link SessionLedgerClient}, or
 * writes an intent and publishes it.
 *
 * With the computer offline, reads answer {@link SessionsOfflineError} (the UI says
 * "computer offline"): the hub has no copy to show.
 */

/** A sessions row as the computer returns it. */
export interface LedgerSessionRow {
  conversationId: string
  origin: ConversationOrigin
  startedAt: number
  lastActiveAt: number
  ownerTabId: string
  currentInOtherTab: boolean
  isCurrent: boolean
}

/** What the hub can ask the computer holding a task's sessions (apps/hub computer-session-ledger.ts). */
export interface SessionLedgerClient {
  /** The terminal runtime's routed ledger (writes and resume reads). */
  store: TaskSessionStore
  /** One raw ledger operation on a computer (tests drive the ledger through it). */
  call<T>(computerId: string, op: string, args?: object): Promise<T>
  /** The connected computer holding a task's sessions, ready to answer; null = offline. */
  forTask(taskId: string): Promise<string | null>
  /** Deliver a task's new intents to its connected computers (offline ones: on connect). */
  publishIntents(taskId: string): Promise<void>
  listTaskSessionRows(
    taskId: string,
    mode: string,
    tabId?: string
  ): Promise<{ computerId: string; rows: LedgerSessionRow[] } | null>
  deletableSession(
    taskId: string,
    mode: string,
    conversationId: string
  ): Promise<'ok' | 'not-honored' | 'current'>
  sessionModesInScope(taskId: string, tabId: string | null): Promise<string[] | null>
  listResumeCandidates(
    computerId: string,
    taskId: string,
    mode: string,
    tabId?: string
  ): Promise<string[]>
  claimedByOtherTasks(computerId: string, taskId: string, ids: string[]): Promise<Set<string>>
  getConversationFirstSeenAt(computerId: string, conversationId: string): Promise<number | null>
  legacyConversationHistory(computerId: string, taskId: string, mode: string): Promise<string[]>
  referencedConversationIds(computerId: string): Promise<Set<string>>
}

let client: SessionLedgerClient | null = null

/** Wire the hub's client (composition root). */
export function setTaskSessionLedger(next: SessionLedgerClient | null): void {
  client = next
}

/** The wired client; throws when none (a host without computers has no sessions). */
export function taskSessionLedger(): SessionLedgerClient {
  if (!client) throw new Error('No session ledger is wired on this host')
  return client
}

/** The computer holding a task's sessions is not connected: the hub has no copy. */
export class SessionsOfflineError extends Error {
  readonly code = 'computer-offline'
  constructor() {
    super('The computer holding this task’s sessions is offline.')
    this.name = 'SessionsOfflineError'
  }
}

type SessionPromptReader = (
  db: SlayzoneDb,
  taskId: string,
  conversationIds: string[]
) => Promise<Array<{ conversationId: string; count: number; firstPrompt: string }>>
let sessionPromptReader: SessionPromptReader | null = null
export function setTaskSessionPromptReader(reader: SessionPromptReader | null): void {
  sessionPromptReader = reader
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
  /** User prompts captured or recovered for this conversation; null when unavailable. */
  messageCount: number | null
  /** Earliest captured user prompt text — the human-readable session label. */
  firstPrompt: string | null
  /** The tab that owns it: the tab of its latest claim (a pick moves it). */
  ownerTabId: string
  /** Another tab's CURRENT session: it cannot be deleted. */
  currentInOtherTab: boolean
  /** True when this conversation is the asking tab's honored "current" one (reset-aware). */
  isCurrent: boolean
}

/** Recover pre-recorder Codex chat prompts still held in the tab's event log. */
async function codexChatEventPrompts(
  db: SlayzoneDb,
  taskId: string
): Promise<Map<string, { count: number; firstPrompt: string | null }>> {
  // No event log left once every chat migrated (§9 Phase 8): nothing to recover.
  if (!(await legacyChatTables(db))) return new Map()
  const events = await db.all<{
    tab_id: string
    seq: number
    kind: string
    session_id: string | null
    conversation_id: string | null
    message_id: string | null
    text: string | null
  }>(
    `SELECT e.tab_id, e.seq,
            json_extract(e.event, '$.kind') AS kind,
            json_extract(e.event, '$.sessionId') AS session_id,
            json_extract(e.event, '$.conversationId') AS conversation_id,
            json_extract(e.event, '$.id') AS message_id,
            json_extract(e.event, '$.text') AS text
       FROM chat_events e
       JOIN terminal_tabs t ON t.id = e.tab_id
      WHERE t.task_id = ? AND t.mode = 'codex-chat'
        AND json_extract(e.event, '$.kind') IN ('turn-init', 'conversation-branch', 'user-message')
      ORDER BY e.tab_id, e.seq`,
    [taskId]
  )
  const summaries = new Map<string, { count: number; firstPrompt: string | null }>()
  const seen = new Set<string>()
  let tabId: string | null = null
  let conversationId: string | null = null
  for (const event of events) {
    if (event.tab_id !== tabId) {
      tabId = event.tab_id
      conversationId = null
    }
    if (event.kind === 'turn-init') {
      conversationId = event.session_id
      continue
    }
    if (event.kind === 'conversation-branch') {
      conversationId = event.conversation_id
      continue
    }
    const text = event.text?.trim()
    if (!conversationId || !text || isSyntheticChatPrompt(text)) continue
    const key = `${conversationId}:${event.message_id ?? `${event.tab_id}:${event.seq}`}`
    if (seen.has(key)) continue
    seen.add(key)
    const prior = summaries.get(conversationId)
    if (prior) prior.count += 1
    else summaries.set(conversationId, { count: 1, firstPrompt: text })
  }
  return summaries
}

/**
 * Per-conversation prompt summaries of Codex chat prompts still held in the hub's
 * legacy chat events (a conversation whose history migration waits). Read-only.
 * Every other prompt lives on the computer (robustness plan §9; v207 moved the
 * hub's captured prompts there).
 */
export async function legacyCodexChatPromptSummaries(
  db: SlayzoneDb,
  taskId: string,
  conversationIds: string[]
): Promise<Array<{ conversationId: string; count: number; firstPrompt: string }>> {
  if (!conversationIds.length) return []
  const events = await codexChatEventPrompts(db, taskId)
  const result: Array<{ conversationId: string; count: number; firstPrompt: string }> = []
  for (const id of new Set(conversationIds)) {
    const found = events.get(id)
    if (found)
      result.push({ conversationId: id, count: found.count, firstPrompt: found.firstPrompt ?? '' })
  }
  return result
}

/**
 * Every agent session tied to (taskId, mode), one entry per distinct provider
 * conversation, newest first, as tab `tabId` sees it — read from the computer
 * holding them, with each session's prompt summary from wherever its prompts live.
 * Throws {@link SessionsOfflineError} when that computer is not connected.
 */
export async function listTaskSessions(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  tabId: string = taskId
): Promise<TaskSessionSummary[]> {
  const found = await taskSessionLedger().listTaskSessionRows(taskId, mode, tabId)
  if (!found) throw new SessionsOfflineError()
  const ids = found.rows.map((r) => r.conversationId)
  const summaries = new Map(
    (sessionPromptReader
      ? await sessionPromptReader(db, taskId, ids)
      : mode === 'codex-chat'
        ? await legacyCodexChatPromptSummaries(db, taskId, ids)
        : []
    ).map((s) => [s.conversationId, s])
  )
  return found.rows.map((r) => {
    const saved = summaries.get(r.conversationId)
    return {
      ...r,
      messageCount: saved?.count ? saved.count : mode === 'codex-chat' ? null : 0,
      firstPrompt: saved?.count ? saved.firstPrompt : null
    }
  })
}

/** Is `conversationId` an honored, undeleted session of (task, mode)? Offline: an error. */
export async function isHonoredConversation(
  taskId: string,
  mode: string,
  conversationId: string
): Promise<boolean> {
  const ledger = taskSessionLedger()
  const computerId = await ledger.forTask(taskId)
  if (!computerId) throw new SessionsOfflineError()
  return ledger.store.isHonoredConversation(computerId, taskId, mode, conversationId)
}

/** Write one deletion tombstone (user intent) and publish it to the task's computers. */
async function writeDeletion(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  conversationId: string
): Promise<void> {
  await db.run(
    `INSERT INTO session_deletions (id, task_id, mode, conversation_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [randomUUID(), taskId, mode, conversationId, Date.now()]
  )
  await taskSessionLedger().publishIntents(taskId)
  agentSessionsEvents.emit('agent-sessions:changed', { taskId })
}

/**
 * Delete one session from the task (the sessions sidebar): a tombstone, never a
 * delete — the transcript on disk is untouched. Refused for a session that is not
 * the task's (`not-honored`) or is a tab's CURRENT one (`current`: a live agent runs
 * it, or resumes it next). The computer holding the sessions decides; offline is an
 * error.
 */
export async function deleteSession(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  conversationId: string
): Promise<'deleted' | 'not-honored' | 'current'> {
  const verdict = await taskSessionLedger().deletableSession(taskId, mode, conversationId)
  if (verdict !== 'ok') return verdict
  await writeDeletion(db, taskId, mode, conversationId)
  return 'deleted'
}

/**
 * Withdraw this task's claim on a provider session it must not drive (the
 * shared-session repair): a tombstone like {@link deleteSession}, without its guard.
 */
export async function relinquishSession(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  conversationId: string
): Promise<void> {
  await writeDeletion(db, taskId, mode, conversationId)
}
