import type { SlayzoneDb } from '@slayzone/platform'
import { legacyChatTables } from '@slayzone/platform/legacy-chat-tables'
import type { ChatOwnership, ChatTabTransition, ConversationIdentity } from '../shared'
import {
  createChatOwnershipStore,
  isStaleLocator,
  retiredComputerSql,
  staleLocatorSql
} from './hub-ownership'
import type { ChatComputerRequest } from './migration'
import { legacyChatTabContentSql } from './legacy-census'
import { isStorageOnlyChatOwner } from './storage-mode'
import { isolateItem } from './hub-isolation'

export interface ComputerChatInventory extends ChatOwnership {
  inbox?: boolean
  hasConversationContent?: boolean
  lifecycle?: { state: 'active' | 'paused' | 'deleted'; revision: number }
  bootstrapRevision: number
  tabTransitions?: ChatTabTransition[]
  /**
   * The conversation's metadata counter, its task's metadata state version and
   * its newest saved event sequence. Recovery compares them with what the hub
   * already applied and relayed, so a reconnect re-fetches and reloads only
   * conversations that changed. Absent from older computers: recovery then
   * treats the conversation as changed.
   */
  metadataCounter?: number
  stateVersion?: number
  historySeq?: number
  /** The chat database `metadataCounter` counts in (see `ChatStorage.storeId`). */
  storeId?: string
  /** The computer cannot read this conversation (recorded in its item_faults): leave it as is. */
  unreadable?: boolean
}
/**
 * A computer holds a conversation (the same one, as new or newer) that the hub
 * assigns to another computer that is not retired. When that owner is the same
 * machine re-enrolled under a new id, the user can replace it with the holder
 * (`computers.replace`), which moves its work and lets the next recovery adopt
 * the chat. Recovery collects these as takeover candidates; it never decides.
 */
export class ChatHeldByAnotherComputerError extends Error {
  readonly conversationId: string
  readonly taskId: string
  readonly ownerComputerId: string
  readonly holderComputerId: string
  constructor(
    info: {
      conversationId: string
      taskId: string
      ownerComputerId: string
      holderComputerId: string
    },
    names: { owner: string; holder: string }
  ) {
    super(
      `${names.holder} holds this chat, but the hub assigns it to another computer, ${names.owner}. ` +
        `If ${names.holder} is ${names.owner} enrolled again, replace ${names.owner} with it ` +
        '(Settings → Connections, or `slay hub computers replace`); otherwise reconnect ' +
        `${names.owner}.`
    )
    this.name = 'ChatHeldByAnotherComputerError'
    this.conversationId = info.conversationId
    this.taskId = info.taskId
    this.ownerComputerId = info.ownerComputerId
    this.holderComputerId = info.holderComputerId
  }

  /** With both computers' names; equal names are told apart by their ids. */
  static async describe(
    db: SlayzoneDb,
    info: ConstructorParameters<typeof ChatHeldByAnotherComputerError>[0]
  ): Promise<ChatHeldByAnotherComputerError> {
    const rows = await db.all<{ id: string; name: string }>(
      'SELECT id,name FROM computers WHERE id IN (?,?)',
      [info.ownerComputerId, info.holderComputerId]
    )
    const nameOf = (id: string) => rows.find((r) => r.id === id)?.name
    const owner = nameOf(info.ownerComputerId)
    const holder = nameOf(info.holderComputerId)
    const label = (id: string, name: string | undefined) =>
      name === undefined
        ? `computer ${id.slice(0, 8)}`
        : owner === holder
          ? `${name} (${id.slice(0, 8)})`
          : name
    return new ChatHeldByAnotherComputerError(info, {
      owner: label(info.ownerComputerId, owner),
      holder: label(info.holderComputerId, holder)
    })
  }
}

/** Computer commits and tombstones survive restoring an older hub database. */
export function createChatRecovery(opts: {
  db: SlayzoneDb
  request: ChatComputerRequest
  gate?(computerId: string, taskId: string): Promise<void>
  recoverTabTransitions?(
    computerId: string,
    identity: ConversationIdentity,
    transitions: ChatTabTransition[]
  ): Promise<void>
  /**
   * One conversation could not be reconciled (`null`: the computer reported an
   * entry without a valid identity). Recovery continued without it.
   */
  onConversationFailure?(computerId: string, conversationId: string | null, error: Error): void
}) {
  const { db } = opts,
    owners = createChatOwnershipStore(db),
    pending = new Map<string, Promise<ComputerChatInventory[]>>()
  async function run(computerId: string): Promise<ComputerChatInventory[]> {
    // Capture expectations before the inventory RPC. A bootstrap which commits
    // while inventory is in flight must not be mistaken for missing old data.
    const expected = await db.all<{ id: string; epoch: number; taskId: string }>(
      "SELECT id,epoch,task_id AS taskId FROM chat_ownership WHERE computer_id=? AND state='active'",
      [computerId]
    )
    const inventory = (await opts.request(computerId, {
      kind: 'inventory'
    })) as ComputerChatInventory[]
    if (!Array.isArray(inventory)) throw new Error('Invalid computer chat inventory')
    for (const entry of inventory) {
      // One conversation the hub cannot reconcile is fenced on its own (its chat
      // reports the error); the computer's other conversations still recover.
      await isolateItem(
        `recovery of conversation ${entry?.identity?.id ?? '(invalid)'}`,
        async () => {
          if (entry?.unreadable) throw new Error('Conversation cannot be read on its computer')
          const i = entry.identity
          if (
            !i ||
            !Number.isSafeInteger(i.epoch) ||
            i.epoch < 1 ||
            !Number.isSafeInteger(entry.bootstrapRevision) ||
            entry.bootstrapRevision < 0
          )
            throw new Error('Invalid computer ownership')
          // Authorization precedes every mutation, including restore-time tombstones.
          // A task absent from this hub snapshot stays only on the computer for now.
          if (!(await db.get('SELECT 1 FROM tasks WHERE id=?', [i.taskId]))) return
          await opts.gate?.(computerId, i.taskId)
          const known = await owners.get(i.id)
          if (entry.state !== 'deleted' && known?.state === 'deleted') {
            // The hub deleted it; this computer still holds it. Deletion follows
            // the hub here: deliver it, never resurrect the conversation.
            if (known.taskId !== i.taskId) throw new Error('Deleted chat identity conflict')
            await owners.queueDeletion(i.id, computerId, i.epoch)
            return
          }
          if (i.id.startsWith('task-tombstone:')) {
            if (entry.state === 'deleted') await owners.deleteForTask(i.taskId)
            return
          }
          await db.run(
            'INSERT INTO chat_task_computers VALUES(?,?) ON CONFLICT(task_id,computer_id) DO NOTHING',
            [i.taskId, computerId]
          )
          // Revisions are reconciled for every task (with or without chats) by
          // the lifecycle inventory (hub-lifecycle `reconcile`); here a deletion
          // the computer committed only stops this entry's recovery.
          if (entry.lifecycle?.state === 'deleted') {
            await owners.deleteForTask(i.taskId)
            return
          }
          if (
            entry.state === 'active' &&
            entry.tabTransitions?.length &&
            !(await db.get(
              "SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted'",
              [i.taskId]
            ))
          )
            await opts.recoverTabTransitions?.(computerId, i, entry.tabTransitions)
          const artifactRoot = i.tabId.startsWith('artifact-store:')
          const promptRoot =
            i.tabId === `prompt-history:${i.taskId}` || i.tabId === `task-content:${i.taskId}`
          // Unknown historical providers retain their identity/content without
          // implying a resumable backend or materializing an invented chat tab.
          const storageOnly =
            artifactRoot || promptRoot || !['claude-chat', 'codex-chat'].includes(i.mode)
          if (entry.inbox && !isStorageOnlyChatOwner(i)) return
          if (entry.state === 'deleted') {
            // A computer is authoritative only over content it holds.
            if (known) {
              if (known.taskId !== i.taskId || known.mode !== i.mode)
                throw new Error('Deleted chat identity conflict')
              // Already deleted here: the reporter holds nothing of it any more,
              // so nothing is left to deliver to it.
              if (known.state === 'deleted') {
                await owners.acknowledgeRemoved(known.id, computerId)
                return
              }
              // Another computer holds it now (moved, or re-created there): this
              // tombstone is foreign history, not a deletion of the live chat.
              const holder = known.computerId
              if (holder !== null && holder !== computerId && !(await owners.isRetired(holder)))
                return
              await owners.deleteConversation(known.id, i.epoch)
              return
            }
            // Unknown id. Its tab's current chat is replaced only when that row is
            // a provably stale locator of this very copy (same migration); any
            // other chat in the tab is live and unrelated (e.g. after a provider
            // switch). Otherwise the tombstone is kept on its own.
            const current = await owners.forTab(i.tabId)
            if (
              current &&
              current.taskId === i.taskId &&
              current.mode === i.mode &&
              isStaleLocator(current) &&
              entry.migrationId !== null &&
              current.migrationId === entry.migrationId &&
              !(await owners.bootstrapReservation(current.id))
            ) {
              await owners.deleteConversation(current.id, i.epoch)
              return
            }
            await owners.recordTombstone(i)
            return
          }
          if (entry.state === 'prepared') {
            if (
              !entry.migrationId ||
              !entry.migrationHash ||
              !/^[a-f0-9]{64}$/.test(entry.migrationHash) ||
              i.epoch < 2
            )
              throw new Error('Invalid prepared migration proof')
            const previous = await owners.forTab(i.tabId)
            if (previous?.state === 'deleted') return
            if (previous && (previous.taskId !== i.taskId || previous.mode !== i.mode))
              throw new Error('Prepared chat identity conflict')
            if (previous?.state === 'active') {
              if (
                previous.id !== i.id ||
                previous.computerId !== computerId ||
                previous.epoch !== i.epoch ||
                previous.migrationId !== entry.migrationId ||
                previous.manifestHash !== entry.migrationHash
              )
                throw new Error('Prepared chat conflicts with committed ownership')
              await owners.clearUnavailable(previous.id, computerId, previous.epoch)
              return
            }
            if (previous && (previous.computerId !== null || previous.epoch !== i.epoch - 1))
              throw new Error('Prepared chat ownership epoch conflict')
            if (previous?.destinationComputerId && previous.destinationComputerId !== computerId)
              throw new Error('Prepared chat belongs to another migration destination')
            if (
              !artifactRoot &&
              !promptRoot &&
              !(await db.get('SELECT 1 FROM terminal_tabs WHERE id=? AND task_id=?', [
                i.tabId,
                i.taskId
              ]))
            )
              return
            // A restored pre-cutover snapshot may have no locator, or the original
            // legacy locator without a migration id. Reuse the verified staged id;
            // creating a second destination would leave a permanent prepared orphan.
            await db.batchTxn([
              ...(previous && previous.id !== i.id
                ? [
                    {
                      type: 'run' as const,
                      sql: `DELETE FROM chat_tab_bindings WHERE tab_id=? AND conversation_id=? AND EXISTS(
                SELECT 1 FROM chat_ownership o WHERE o.id=? AND ${staleLocatorSql('o')})`,
                      params: [i.tabId, previous.id, previous.id]
                    }
                  ]
                : []),
              {
                type: 'run',
                sql: `INSERT INTO chat_ownership(id,task_id,tab_id,mode,epoch,state,migration_id,destination_computer_id)
              SELECT ?,?,?,?,?,'copying',?,? WHERE NOT EXISTS(SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted')
              AND NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id<>?)
              ${artifactRoot || promptRoot ? '' : 'AND EXISTS(SELECT 1 FROM terminal_tabs WHERE id=? AND task_id=?)'}
              ON CONFLICT(id) DO UPDATE SET state='copying',migration_id=excluded.migration_id,destination_computer_id=excluded.destination_computer_id,manifest_hash=NULL
              WHERE chat_ownership.task_id=excluded.task_id AND chat_ownership.tab_id=excluded.tab_id AND chat_ownership.mode=excluded.mode
                AND chat_ownership.epoch=excluded.epoch AND chat_ownership.computer_id IS NULL AND chat_ownership.state IN ('legacy','copying','verified')`,
                params: [
                  i.id,
                  i.taskId,
                  i.tabId,
                  i.mode,
                  i.epoch - 1,
                  entry.migrationId,
                  computerId,
                  i.taskId,
                  i.tabId,
                  i.id,
                  ...(artifactRoot || promptRoot ? [] : [i.tabId, i.taskId])
                ]
              },
              {
                type: 'run',
                sql: `INSERT INTO chat_tab_bindings(tab_id,conversation_id) SELECT tab_id,id FROM chat_ownership
              WHERE id=? AND state='copying' AND migration_id=? AND destination_computer_id=? ON CONFLICT(tab_id) DO NOTHING`,
                params: [i.id, entry.migrationId, computerId]
              }
            ])
            const adopted = await owners.forTab(i.tabId)
            if (
              adopted?.id !== i.id ||
              adopted.state !== 'copying' ||
              adopted.migrationId !== entry.migrationId
            )
              throw new Error('Prepared chat ownership changed during recovery')
            if (previous && previous.id !== i.id)
              await db.run(
                `UPDATE chat_ownership SET state='deleted',epoch=epoch+1 WHERE id=? AND ${staleLocatorSql('chat_ownership')} AND NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE conversation_id=?)`,
                [previous.id, previous.id]
              )
            return
          }
          if (entry.state !== 'active') return
          if (
            await db.get("SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted'", [
              i.taskId
            ])
          )
            return
          const previous = await owners.forTab(i.tabId)
          if (previous?.state === 'deleted') return
          if (previous && (previous.taskId !== i.taskId || previous.mode !== i.mode))
            throw new Error('Computer chat identity conflict')
          if (previous) {
            const reservation = await owners.bootstrapReservation(previous.id)
            if (reservation && reservation.computerId !== computerId)
              throw new Error('Chat initialization belongs to another computer')
            if (
              previous.state !== 'active' &&
              previous.destinationComputerId &&
              previous.destinationComputerId !== computerId
            )
              throw new Error('Chat migration belongs to another destination')
          }
          // A chat whose computer was removed for good is adopted by any computer
          // that reports holding the same conversation at the same or a newer epoch.
          const adopting =
            !!previous?.computerId &&
            previous.computerId !== computerId &&
            previous.id === i.id &&
            previous.epoch <= i.epoch &&
            (await owners.isRetired(previous.computerId))
          if (
            previous?.computerId &&
            !adopting &&
            (previous.computerId !== computerId || previous.id !== i.id)
          ) {
            // The same conversation, as new or newer, on another computer than the
            // hub's: possibly that computer re-enrolled under a new id. Only the user
            // can say so (host ids are shared, a credential is gone): never adopted here.
            if (previous.id === i.id && previous.epoch <= i.epoch)
              throw await ChatHeldByAnotherComputerError.describe(db, {
                conversationId: i.id,
                taskId: i.taskId,
                ownerComputerId: previous.computerId,
                holderComputerId: computerId
              })
            throw new Error('Chat tab has another active owner')
          }
          if (previous && previous.epoch > i.epoch)
            throw new Error('Computer chat ownership is behind the hub')
          if (
            previous &&
            (previous.id !== i.id || previous.epoch < i.epoch) &&
            (!entry.migrationId || !entry.migrationHash)
          )
            throw new Error('Newer computer ownership requires a committed migration proof')
          if (entry.migrationHash && !/^[a-f0-9]{64}$/.test(entry.migrationHash))
            throw new Error('Invalid migration proof')
          const tab = await db.get<{ task_id: string; mode: string }>(
            'SELECT task_id,mode FROM terminal_tabs WHERE id=?',
            [i.tabId]
          )
          if (tab && tab.task_id !== i.taskId) throw new Error('Chat tab task conflict')
          if (tab && tab.mode === i.mode && promptRoot && entry.hasConversationContent === false) {
            // Repair the empty tabs created by older reconnects. Unbind only within
            // this transaction so terminal deletion cannot tombstone retained prompts.
            await db.batchTxn([
              {
                type: 'run',
                sql: `DELETE FROM chat_tab_bindings WHERE tab_id=? AND conversation_id=?
              AND EXISTS(SELECT 1 FROM terminal_tabs WHERE id=? AND task_id=? AND label='Chat' AND mode=?)
              AND NOT EXISTS(SELECT 1 FROM chat_threads WHERE id=? OR parent_tab_id=?)`,
                params: [i.tabId, i.id, i.tabId, i.taskId, i.mode, i.tabId, i.tabId]
              },
              {
                type: 'run',
                sql: `DELETE FROM terminal_tabs WHERE id=? AND task_id=? AND label='Chat' AND mode=?
              AND NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=?)
              AND NOT EXISTS(SELECT 1 FROM chat_threads WHERE id=? OR parent_tab_id=?)`,
                params: [i.tabId, i.taskId, i.mode, i.tabId, i.tabId, i.tabId]
              },
              {
                type: 'run',
                sql: `INSERT INTO chat_tab_bindings(tab_id,conversation_id) SELECT ?,id FROM chat_ownership
              WHERE id=? AND state<>'deleted' ON CONFLICT(tab_id) DO NOTHING`,
                params: [i.tabId, i.id]
              }
            ])
          }
          if (!tab && !storageOnly)
            await db.run(
              "INSERT INTO terminal_tabs(id,task_id,label,mode,position) VALUES(?,?,'Chat',?,(SELECT COALESCE(MAX(position),-1)+1 FROM terminal_tabs WHERE task_id=?))",
              [i.tabId, i.taskId, i.mode, i.taskId]
            )
          const replace = previous && previous.id !== i.id
          await db.batchTxn([
            ...(replace
              ? [
                  {
                    type: 'run' as const,
                    sql: `DELETE FROM chat_tab_bindings WHERE tab_id=? AND conversation_id=? AND EXISTS(SELECT 1 FROM chat_ownership o WHERE o.id=? AND ${staleLocatorSql('o')})`,
                    params: [i.tabId, previous.id, previous.id]
                  }
                ]
              : []),
            {
              type: 'run',
              sql: `INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state,migration_id,destination_computer_id,manifest_hash,cleanup_pending,settings_revision)
       SELECT ?,?,?,?,?,?,'active',?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id<>?)
       ON CONFLICT(id) DO UPDATE SET computer_id=excluded.computer_id,epoch=excluded.epoch,state='active',migration_id=excluded.migration_id,destination_computer_id=excluded.destination_computer_id,manifest_hash=excluded.manifest_hash,cleanup_pending=CASE WHEN chat_ownership.epoch<excluded.epoch OR chat_ownership.state<>'active' THEN excluded.cleanup_pending ELSE chat_ownership.cleanup_pending END,settings_revision=MAX(chat_ownership.settings_revision,excluded.settings_revision),settings_hash=NULL
       WHERE chat_ownership.task_id=excluded.task_id AND chat_ownership.tab_id=excluded.tab_id AND chat_ownership.mode=excluded.mode AND chat_ownership.state<>'deleted' AND chat_ownership.epoch<=excluded.epoch AND (chat_ownership.computer_id IS NULL OR chat_ownership.computer_id=excluded.computer_id OR ${retiredComputerSql('chat_ownership.computer_id')})`,
              params: [
                i.id,
                i.taskId,
                i.tabId,
                i.mode,
                computerId,
                i.epoch,
                entry.migrationId,
                computerId,
                entry.migrationHash,
                entry.migrationId ? 1 : 0,
                entry.bootstrapRevision,
                i.tabId,
                i.id
              ]
            },
            {
              type: 'run',
              sql: "INSERT INTO chat_tab_bindings(tab_id,conversation_id) SELECT ?,id FROM chat_ownership WHERE id=? AND computer_id=? AND epoch=? AND state='active' ON CONFLICT(tab_id) DO NOTHING",
              params: [i.tabId, i.id, computerId, i.epoch]
            }
          ])
          const adopted = await owners.forTab(i.tabId)
          if (
            adopted?.id !== i.id ||
            adopted.computerId !== computerId ||
            adopted.epoch !== i.epoch
          )
            throw new Error('Chat ownership changed during recovery')
          await owners.clearUnavailable(i.id, computerId, i.epoch)
          if (adopting) await owners.clearUnavailable(i.id, previous!.computerId!, previous!.epoch)
          // New task-wide authorities replace the old prompt-history storage root.
          // Older reconnects could leave its generated UI row without a locator.
          // Remove it only when neither hub content nor any computer store
          // claims it; a real later chat (including an un-migrated draft) survives.
          const oldPromptTab = `prompt-history:${i.taskId}`
          const tables = await legacyChatTables(db)
          if (
            i.tabId === `task-content:${i.taskId}` &&
            !inventory.some((item) => item.identity.tabId === oldPromptTab) &&
            (await db.get(
              `SELECT 1 FROM terminal_tabs t WHERE t.id=? AND t.task_id=? AND t.label='Chat' AND t.mode=?
            AND NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=t.id)
            AND NOT ${legacyChatTabContentSql(tables)}`,
              [oldPromptTab, i.taskId, i.mode]
            ))
          )
            await db.run(
              `DELETE FROM terminal_tabs WHERE id=? AND task_id=? AND label='Chat' AND mode=?
                AND NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=terminal_tabs.id)
                AND NOT ${legacyChatTabContentSql(tables, 'terminal_tabs')}`,
              [oldPromptTab, i.taskId, i.mode]
            )
          // The replaced unbound row is only a stale locator, never a second owner.
          if (replace)
            await db.run(
              `UPDATE chat_ownership SET state='deleted',epoch=epoch+1 WHERE id=? AND ${staleLocatorSql('chat_ownership')} AND NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE conversation_id=?)`,
              [previous.id, previous.id]
            )
        },
        (error) => opts.onConversationFailure?.(computerId, entry?.identity?.id ?? null, error)
      )
    }
    const present = new Set(inventory.map((entry) => entry.identity.id))
    for (const owner of expected) {
      if (
        present.has(owner.id) ||
        !(await db.get('SELECT 1 FROM tasks WHERE id=?', [owner.taskId]))
      )
        continue
      await isolateItem(
        `availability of conversation ${owner.id}`,
        async () => {
          await opts.gate?.(computerId, owner.taskId)
          await owners.markUnavailable(owner.id, computerId, owner.epoch)
        },
        (error) => opts.onConversationFailure?.(computerId, owner.id, error)
      )
    }
    return inventory
  }
  return {
    /** Resolves with the computer's inventory, as read for this reconciliation. */
    reconcile(computerId: string): Promise<ComputerChatInventory[]> {
      const current = pending.get(computerId)
      if (current) return current
      const work = run(computerId).finally(() => pending.delete(computerId))
      pending.set(computerId, work)
      return work
    }
  }
}
