import type { SlayzoneDb } from '@slayzone/platform'
import {
  type ChatAvailability,
  type ChatUnavailableReason,
  chatUnavailableDetail
} from '@slayzone/terminal-contracts'
import { computerStanding, type ComputerStanding } from '@slayzone/computers/server'
import type { ChatOwnershipStore } from './hub-ownership'
import { legacyChatTables } from '@slayzone/platform/legacy-chat-tables'
import { chatComputer } from './hub-chat-computer'

/** 'unavailable', with why: its code, and the text for clients that predate codes. */
const unavailable = (
  computer: ChatAvailability['computer'],
  reason: ChatUnavailableReason
): ChatAvailability => ({
  state: 'unavailable',
  computer,
  reasonCode: reason,
  reason: chatUnavailableDetail(reason)
})

/**
 * A client's loaded history is stale when this changes: a recovery that found
 * the conversation changed (`recovery` is per conversation), or a new binding.
 */
export const chatHistoryGeneration = (recovery: string, id: string, epoch: number): string =>
  JSON.stringify([recovery, id, epoch])

/** Metadata only: checking availability must never migrate or fall back to hub content. */
export function createChatAvailability(opts: {
  db: SlayzoneDb
  ownership: ChatOwnershipStore
  resolveComputer(taskId: string): Promise<string | null>
  connected(computerId: string): boolean
  chatRuntimeReady?(computerId: string): boolean
  /** The conversation's history generation (see {@link chatHistoryGeneration}). */
  historyGeneration?(computerId: string, conversationId: string, epoch: number): string
  hasLiveTask(taskId: string): Promise<boolean>
  gate?(computerId: string, taskId: string): Promise<void>
  /**
   * The computer that reported holding this conversation while the hub assigns it to
   * `ownerId` (a takeover candidate: possibly the owner enrolled again), or null.
   */
  heldBy?(conversationId: string, ownerId: string): string | null
}) {
  return async (tabId: string): Promise<ChatAvailability> => {
    const tab = await opts.db.get<{ task_id: string; state: string | null }>(
      'SELECT t.task_id,l.state FROM terminal_tabs t LEFT JOIN chat_task_lifecycle l ON l.task_id=t.task_id WHERE t.id=?',
      [tabId]
    )
    if (!tab) throw new Error('Unknown chat tab')
    const owner = await opts.ownership.forTab(tabId)
    // The chat's computer as the hub answers it everywhere (`chatComputer`): its
    // successor if re-enrolled; a removed one is the answer, decided before "offline"
    // (which would ask the user to connect a computer that never connects again).
    let standing: ComputerStanding | null = owner ? await chatComputer(opts.db, owner) : null
    // Where a hub-era tab's agent ran (v196), while this install still has the record.
    // A removed computer's record goes with its retirement: the chat is placed again.
    const recorded =
      !standing && (await legacyChatTables(opts.db))
        ? await opts.db.get<{ computer_id: string }>(
            'SELECT computer_id FROM chat_legacy_tab_computers WHERE tab_id=?',
            [tabId]
          )
        : null
    if (recorded) {
      const was = await computerStanding(opts.db, recorded.computer_id)
      if (was.kind !== 'removed') standing = was
    }
    if (!standing) {
      const placed = await opts.resolveComputer(tab.task_id)
      if (placed) standing = await computerStanding(opts.db, placed)
    }
    let computer: ChatAvailability['computer'] = null
    if (standing) {
      // A removed computer is no one's: there is nothing to authorize (the tab's own
      // access is checked by the caller), and asking would refuse instead of telling why.
      if (standing.kind !== 'removed') await opts.gate?.(standing.id, tab.task_id)
      const row = await opts.db.get<{ name: string }>('SELECT name FROM computers WHERE id=?', [
        standing.id
      ])
      computer = { id: standing.id, name: row?.name ?? 'Computer' }
    }
    if (tab.state === 'deleted' || owner?.state === 'deleted') return { state: 'deleted', computer }
    if (tab.state === 'paused') return { state: 'paused', computer }
    if (!computer || !standing) return { state: 'unassigned', computer: null }
    if (standing.kind === 'removed') return unavailable(computer, 'computer-removed')
    if (!opts.connected(computer.id)) {
      // Said where the user is stuck: another computer holds this chat, so replacing
      // the offline one with it (if it is the same machine) is the way out.
      const holder = owner?.computerId === computer.id ? opts.heldBy?.(owner.id, computer.id) : null
      const held = holder
        ? await opts.db.get<{ name: string }>('SELECT name FROM computers WHERE id=?', [holder])
        : undefined
      return {
        state: 'offline',
        computer,
        ...(holder && held ? { heldBy: { id: holder, name: held.name } } : {})
      }
    }
    if (opts.chatRuntimeReady?.(computer.id) === false) return { state: 'upgrading', computer }
    if (!owner) return { state: 'preparing', computer }
    const missing = await opts.ownership.unavailable(owner.id)
    if (missing) return unavailable(computer, missing.reason)
    if (await opts.ownership.bootstrapReservation(owner.id)) return { state: 'preparing', computer }
    if (owner.state !== 'active' || owner.cleanupPending)
      return { state: 'migrating', computer, waitingForAgents: await opts.hasLiveTask(tab.task_id) }
    const generation = opts.historyGeneration?.(computer.id, owner.id, owner.epoch)
    return {
      state: 'ready',
      computer,
      ...(generation ? { recoveryGeneration: generation } : {})
    }
  }
}
