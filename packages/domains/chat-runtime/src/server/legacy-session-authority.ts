import type { SlayzoneDb } from '@slayzone/platform'
import { legacyChatTables } from '@slayzone/platform/legacy-chat-tables'
import { createChatOwnershipStore, type HubChatOwnership } from './hub-ownership'
import { terminalStorageAgentId } from './storage-mode'

type ResolveComputer = (owner: HubChatOwnership) => Promise<string | null>

/** Historical session lists are shared metadata, not proof that every copy owns
 * the provider session. Elect from provider/tab/computer provenance. An
 * ambiguous cross-computer session remains readable history without a claim.
 *
 * Row states in `chat_legacy_session_authority`:
 * - `conversation_id` set: elected owner. Final — replays must never flip it.
 * - `conversation_id` NULL: ambiguous. ≥1 chat owner competes for the session but
 *   their computers disagree or are unknown. NOT final: re-elected on every read,
 *   so a later proof (or a stale NULL) resolves monotonically NULL → owner.
 * - no row: unclaimed. No chat owner of this provider competes (e.g. a terminal
 *   agent session in a task whose only chat owner is storage-only). Nothing is
 *   ambiguous, so nothing is fenced.
 *
 * v0.37.0 wrote NULL for the unclaimed case too, fencing every terminal-agent
 * resume in such tasks (#172). Re-electing NULL rows deletes those.
 *
 * Once the legacy chat tables are dropped (every chat migrated, §9 Phase 8) no
 * hub-era session is left to elect: every session is unclaimed here (the computers
 * holding chats answer for theirs, `chatSessionOwner`). */
export async function legacySessionAuthority(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  sessionId: string,
  resolveComputer?: ResolveComputer
): Promise<string | null> {
  if (!(await legacyChatTables(db))) return null
  const canonical = terminalStorageAgentId(mode)
  const existing = await db.get<{ conversation_id: string | null }>(
    'SELECT conversation_id FROM chat_legacy_session_authority WHERE task_id=? AND mode=? AND provider_session_id=?',
    [taskId, canonical, sessionId]
  )
  if (existing?.conversation_id) return existing.conversation_id
  const election = await elect(db, taskId, mode, canonical, sessionId, resolveComputer)
  if (!election.contested) {
    await db.run(
      'DELETE FROM chat_legacy_session_authority WHERE task_id=? AND mode=? AND provider_session_id=? AND conversation_id IS NULL',
      [taskId, canonical, sessionId]
    )
    return null
  }
  // A concurrent election may have won first: an elected row is never replaced.
  await db.run(
    `INSERT INTO chat_legacy_session_authority VALUES(?,?,?,?) ON CONFLICT(task_id,mode,provider_session_id)
    DO UPDATE SET conversation_id=excluded.conversation_id
    WHERE chat_legacy_session_authority.conversation_id IS NULL AND excluded.conversation_id IS NOT NULL`,
    [taskId, canonical, sessionId, election.selected]
  )
  return (
    (
      await db.get<{ conversation_id: string | null }>(
        'SELECT conversation_id FROM chat_legacy_session_authority WHERE task_id=? AND mode=? AND provider_session_id=?',
        [taskId, canonical, sessionId]
      )
    )?.conversation_id ?? null
  )
}

/** True only while a recorded ambiguity survives re-election. A session with no
 * authority row was never contested and is not fenced here (that path starts
 * no election, so placement of never-migrated sessions is unchanged). */
export async function legacySessionAmbiguous(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  sessionId: string,
  resolveComputer?: ResolveComputer
): Promise<boolean> {
  if (!(await legacyChatTables(db))) return false
  const canonical = terminalStorageAgentId(mode)
  const ambiguous = () =>
    db.get(
      'SELECT 1 FROM chat_legacy_session_authority WHERE task_id=? AND mode=? AND provider_session_id=? AND conversation_id IS NULL',
      [taskId, canonical, sessionId]
    )
  if (!(await ambiguous())) return false
  await legacySessionAuthority(db, taskId, mode, sessionId, resolveComputer)
  return !!(await ambiguous())
}

async function elect(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  canonical: string,
  sessionId: string,
  resolveComputer?: ResolveComputer
): Promise<{ contested: boolean; selected: string | null }> {
  // A chat that already holds the session on its computer is found before this
  // runs (the hub asks the computers: `chatSessionOwner`, v208). What is elected
  // here is a session no reachable computer claims.
  const store = createChatOwnershipStore(db)
  const candidates: Array<{
    owner: HubChatOwnership
    computer: string | null
    evidence: boolean
    order: string
  }> = []
  for (const owner of await store.forTask(taskId)) {
    if (owner.state === 'deleted' || terminalStorageAgentId(owner.mode) !== canonical) continue
    // Storage-only owners (`task-content:`, `artifact-store:`) have no tab: they
    // hold task history, never a provider session, so they do not compete.
    const tab = await db.get<{ created_at: string }>(
      'SELECT created_at FROM terminal_tabs WHERE id=? AND task_id=?',
      [owner.tabId, taskId]
    )
    if (!tab) continue
    // Where a hub-era tab's agent ran: v196's record, not the legacy table.
    const recorded = await db.get<{ computer_id: string }>(
      'SELECT computer_id FROM chat_legacy_tab_computers WHERE tab_id=?',
      [owner.tabId]
    )
    const computer =
      owner.computerId ??
      owner.destinationComputerId ??
      recorded?.computer_id ??
      (await resolveComputer?.(owner)) ??
      null
    const evidence = !!(await db.get(
      `SELECT 1 FROM chat_events WHERE tab_id=? AND json_valid(event) AND
      ((json_extract(event,'$.kind')='turn-init' AND json_extract(event,'$.sessionId')=?) OR
      (json_extract(event,'$.kind')='conversation-branch' AND json_extract(event,'$.conversationId')=?)) LIMIT 1`,
      [owner.tabId, sessionId, sessionId]
    ))
    candidates.push({ owner, computer, evidence, order: `${tab.created_at}:${owner.tabId}` })
  }
  if (!candidates.length) return { contested: false, selected: null }
  const proven = candidates.filter((candidate) => candidate.evidence)
  const choices = proven.length ? proven : candidates
  const selected = choices.every(
    (candidate) => candidate.computer && candidate.computer === choices[0].computer
  )
    ? choices.sort((a, b) => a.order.localeCompare(b.order))[0].owner.id
    : null
  return { contested: true, selected }
}
