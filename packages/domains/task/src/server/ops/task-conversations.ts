import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { chatAgentIdForTerminal, isChatSupported } from '@slayzone/terminal-contracts'
import { agentSessionsEvents } from '../events'
import { SessionsOfflineError, taskSessionLedger } from './agent-sessions'

/**
 * Session intent and session moves, from the hub (robustness plan §9, P0). The
 * ledger itself is on the computer running the task's agents; see agent-sessions.ts.
 */

/**
 * Reset agent sessions: the next spawn in scope starts fresh. THE reset write —
 * the sessions UI, `slay tasks reset-conversation`, REST, a worktree / project
 * change and a main-agent switch all come here, so a reset means one thing.
 *
 * A reset is the user's intent, kept by the hub (`session_resets`) and delivered to
 * every computer of the task — an offline one when it connects — so it works with
 * the computer offline. `scope`: one tab (`{ tabId }`; the main tab's id is the task
 * id), or `'all-tabs'` (stored without a tab). A tab's reset never touches another.
 *
 * `mode` omitted = every mode (stored as `*`; `exceptChat` leaves the chat modes,
 * whose conversation the chat runtime owns per tab — the main-agent switch). Every
 * mode, not only those with a session: a mode with no session before the reset has
 * nothing to cut, so the two are the same reset.
 *
 * Returns the modes reported reset: `[mode]`, else the modes the computer holds
 * sessions of in scope (none → nothing was written, as before), else — computer
 * offline — `['*']`.
 */
export async function resetConversation(
  db: SlayzoneDb,
  args: {
    taskId: string
    mode?: string
    /** With no `mode`: leave the chat modes (the main-agent switch). */
    exceptChat?: boolean
    scope: { tabId: string } | 'all-tabs'
  }
): Promise<string[]> {
  const { taskId } = args
  const tabId = args.scope === 'all-tabs' ? null : args.scope.tabId
  let reported: string[]
  if (args.mode) reported = [args.mode]
  else {
    const held = await taskSessionLedger().sessionModesInScope(taskId, tabId)
    reported = held
      ? held.filter((m) => !(args.exceptChat && isChatSupported(m)))
      : [args.exceptChat ? '* (except chat)' : '*']
    if (held && !reported.length) return []
  }
  await db.run(
    `INSERT INTO session_resets (id, task_id, mode, tab_id, except_chat, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      taskId,
      args.mode ?? '*',
      tabId,
      !args.mode && args.exceptChat ? 1 : 0,
      Date.now()
    ]
  )
  await taskSessionLedger().publishIntents(taskId)
  agentSessionsEvents.emit('agent-sessions:changed', { taskId })
  return reported
}

/**
 * Make one of the task's sessions the current one of `mode` (the Sessions list).
 *
 * `sourceMode` is the mode that ran it. The Claude family shows chat and terminal
 * sessions in one list, so a session of the chat ↔ terminal partner may be picked
 * too: the conversation moves over (`handoff`). Any other mode's session is refused
 * (`not-partner`); the id must be an honored, undeleted session of this task under
 * the mode that ran it (`not-honored`). A session live in another tab is refused,
 * naming that tab. Recorded on the computer holding the sessions; offline: an error.
 */
export async function switchConversation(
  _db: SlayzoneDb,
  args: {
    taskId: string
    mode: string
    conversationId: string
    sourceMode?: string
    /** The tab picking it; omitted = the main tab. The conversation MOVES here. */
    tabId?: string
  },
  deps: {
    release: (taskId: string, conversationId: string) => Promise<void>
    liveInOtherTab?: (
      taskId: string,
      conversationId: string,
      tabId: string
    ) => Promise<string | null>
  }
): Promise<'switched' | 'not-partner' | 'not-honored' | { inUseBy: string }> {
  const { taskId, mode, conversationId } = args
  const tabId = args.tabId ?? taskId
  const source = args.sourceMode ?? mode
  const handoff = source !== mode
  if (handoff && chatAgentIdForTerminal(mode) !== source && chatAgentIdForTerminal(source) !== mode)
    return 'not-partner'
  const ledger = taskSessionLedger()
  const computerId = await ledger.forTask(taskId)
  if (!computerId) throw new SessionsOfflineError()
  if (!(await ledger.store.isHonoredConversation(computerId, taskId, source, conversationId)))
    return 'not-honored'
  const holder = await deps.liveInOtherTab?.(taskId, conversationId, tabId)
  if (holder) return { inUseBy: holder }
  if (handoff && isChatSupported(source)) await deps.release(taskId, conversationId)
  await ledger.store.recordConversation(computerId, {
    taskId,
    mode,
    tabId,
    conversationId,
    origin: handoff ? 'handoff' : 'user-selected',
    ...(isChatSupported(mode) ? { legacyJsonField: 'chatConversationId' as const } : {})
  })
  agentSessionsEvents.emit('agent-sessions:changed', { taskId })
  return 'switched'
}
