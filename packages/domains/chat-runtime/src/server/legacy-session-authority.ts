import type { SlayzoneDb } from '@slayzone/platform'
import { createChatOwnershipStore, type HubChatOwnership } from './hub-ownership'
import { terminalStorageMode } from './storage-mode'

/** Historical session lists are shared metadata, not proof that every copy owns
 * the provider session. Elect once from provider/tab/computer provenance. An
 * ambiguous cross-computer session remains readable history without a claim. */
export async function legacySessionAuthority(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  sessionId: string,
  resolveComputer?: (owner: HubChatOwnership) => Promise<string | null>
): Promise<string | null> {
  const canonical = terminalStorageMode(mode)
  const existing = await db.get<{ conversation_id: string | null }>(
    'SELECT conversation_id FROM chat_legacy_session_authority WHERE task_id=? AND mode=? AND provider_session_id=?',
    [taskId, canonical, sessionId]
  )
  if (existing) return existing.conversation_id
  const store = createChatOwnershipStore(db)
  const bound = await store.forProviderSession(sessionId, mode)
  let selected =
    bound?.taskId === taskId &&
    bound.state === 'active' &&
    terminalStorageMode(bound.mode) === canonical
      ? bound.id
      : null
  if (!selected) {
    const candidates: Array<{
      owner: HubChatOwnership
      computer: string | null
      evidence: boolean
      order: string
    }> = []
    for (const owner of await store.forTask(taskId)) {
      if (owner.state === 'deleted' || terminalStorageMode(owner.mode) !== canonical) continue
      const tab = await db.get<{ created_at: string }>(
        'SELECT created_at FROM terminal_tabs WHERE id=? AND task_id=?',
        [owner.tabId, taskId]
      )
      if (!tab) continue
      const recorded = await db.get<{ computer_id: string }>(
        'SELECT computer_id FROM chat_workspace_changes WHERE tab_id=? AND computer_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1',
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
    const proven = candidates.filter((candidate) => candidate.evidence)
    const choices = proven.length ? proven : candidates
    if (
      choices.length &&
      choices.every((candidate) => candidate.computer && candidate.computer === choices[0].computer)
    )
      selected = choices.sort((a, b) => a.order.localeCompare(b.order))[0].owner.id
  }
  await db.run(
    'INSERT INTO chat_legacy_session_authority VALUES(?,?,?,?) ON CONFLICT(task_id,mode,provider_session_id) DO NOTHING',
    [taskId, canonical, sessionId, selected]
  )
  return (await db.get<{ conversation_id: string | null }>(
    'SELECT conversation_id FROM chat_legacy_session_authority WHERE task_id=? AND mode=? AND provider_session_id=?',
    [taskId, canonical, sessionId]
  ))!.conversation_id
}
