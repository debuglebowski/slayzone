import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { chatTabTransitionSchema, type ChatTabTransition } from '../shared'
import type { ChatComputerRequest } from './migration'
import {
  notifyChatOwnershipChange,
  type ChatOwnershipStore,
  type HubChatOwnership
} from './hub-ownership'
import { chatStorageMode } from './storage-mode'

interface TransitionRow {
  id: string
  conversation_id: string
  task_id: string
  tab_id: string
  archive_tab_id: string
  next_conversation_id: string
  next_mode: string
  computer_id: string
  epoch: number
  state: string
}
export function createHubProviderTransitions(opts: {
  db: SlayzoneDb
  ownership: ChatOwnershipStore
  request: ChatComputerRequest
  gate?(computerId: string, taskId: string): Promise<void>
  quiesce?(owner: HubChatOwnership): Promise<void>
}) {
  const { db, ownership } = opts
  const pending = new Map<string, Promise<void>>()
  function proof(row: TransitionRow, owner: HubChatOwnership): ChatTabTransition {
    const from = {
      id: row.conversation_id,
      taskId: row.task_id,
      tabId: row.tab_id,
      mode: owner.mode,
      epoch: row.epoch
    }
    return {
      id: row.id,
      from,
      to: { ...from, tabId: row.archive_tab_id, epoch: row.epoch + 1 },
      next: {
        id: row.next_conversation_id,
        taskId: row.task_id,
        tabId: row.tab_id,
        mode: row.next_mode,
        epoch: 1
      }
    }
  }
  async function reserve(value: ChatTabTransition, computerId: string) {
    await db.run(
      `INSERT INTO chat_provider_transitions VALUES(?,?,?,?,?,?,?,?,?,'reserved') ON CONFLICT(id) DO NOTHING`,
      [
        value.id,
        value.from.id,
        value.from.taskId,
        value.from.tabId,
        value.to.tabId,
        value.next.id,
        value.next.mode,
        computerId,
        value.from.epoch
      ]
    )
    const saved = await db.get<TransitionRow>(
      'SELECT * FROM chat_provider_transitions WHERE id=?',
      [value.id]
    )
    if (
      !saved ||
      saved.conversation_id !== value.from.id ||
      saved.task_id !== value.from.taskId ||
      saved.tab_id !== value.from.tabId ||
      saved.archive_tab_id !== value.to.tabId ||
      saved.next_conversation_id !== value.next.id ||
      saved.next_mode !== value.next.mode ||
      saved.computer_id !== computerId ||
      saved.epoch !== value.from.epoch
    )
      throw new Error('Provider transition reservation conflict')
  }
  async function publish(value: ChatTabTransition, computerId: string, restoreSelection = false) {
    const { from, to, next } = value
    const current = await ownership.get(from.id)
    if (current?.state === 'active' && current.tabId === to.tabId && current.epoch === to.epoch) {
      const selected = await ownership.forTab(next.tabId)
      if (selected?.id !== next.id || selected.state === 'deleted')
        throw new Error('Provider transition selected binding changed')
      return
    }
    if (await db.get('SELECT 1 FROM terminal_tabs WHERE id=?', [to.tabId]))
      throw new Error('Provider archive tab already exists')
    const matches = `EXISTS(SELECT 1 FROM chat_ownership o JOIN chat_tab_bindings b ON b.conversation_id=o.id
      JOIN terminal_tabs t ON t.id=b.tab_id WHERE o.id=? AND o.task_id=? AND o.tab_id=? AND o.mode=? AND o.computer_id=? AND o.epoch=? AND o.state='active'
      AND t.task_id=o.task_id AND NOT EXISTS(SELECT 1 FROM chat_task_lifecycle l WHERE l.task_id=o.task_id AND l.state='deleted'))`
    const identity = [from.id, from.taskId, from.tabId, from.mode, computerId, from.epoch]
    await db.batchTxn([
      {
        type: 'run',
        sql: `INSERT INTO terminal_tabs(id,task_id,label,mode,is_main,position,group_id,agent_state)
        SELECT ?,?,COALESCE(t.label,?),?,0,(SELECT COALESCE(MAX(position),-1)+1 FROM terminal_tabs WHERE task_id=?),?,'stopped' FROM terminal_tabs t WHERE t.id=? AND ${matches} ON CONFLICT(id) DO NOTHING`,
        params: [
          to.tabId,
          from.taskId,
          from.mode,
          from.mode,
          from.taskId,
          to.tabId,
          from.tabId,
          ...identity
        ]
      },
      {
        type: 'run',
        sql: `UPDATE terminal_tabs SET mode=?,agent_state='stopped' WHERE id=? AND ? AND
        (CASE mode WHEN 'claude-code' THEN 'claude-chat' WHEN 'codex' THEN 'codex-chat' ELSE mode END)=? AND ${matches}`,
        params: [next.mode, from.tabId, restoreSelection ? 1 : 0, from.mode, ...identity]
      },
      {
        type: 'run',
        sql: `UPDATE chat_ownership SET tab_id=?,epoch=? WHERE id=? AND ${matches}`,
        params: [to.tabId, to.epoch, from.id, ...identity]
      },
      {
        type: 'run',
        sql: `UPDATE chat_tab_bindings SET tab_id=? WHERE tab_id=? AND conversation_id=? AND EXISTS(SELECT 1 FROM chat_ownership WHERE id=? AND tab_id=? AND epoch=? AND state='active')`,
        params: [to.tabId, from.tabId, from.id, from.id, to.tabId, to.epoch]
      },
      {
        type: 'run',
        sql: `UPDATE chat_threads SET parent_tab_id=? WHERE parent_tab_id=? AND task_id=? AND EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id=?)`,
        params: [to.tabId, from.tabId, from.taskId, to.tabId, from.id]
      },
      {
        type: 'run',
        sql: `INSERT INTO chat_ownership(id,task_id,tab_id,mode,epoch,state,destination_computer_id)
        SELECT ?,?,?,?,1,'legacy',? WHERE EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id=?)
        AND EXISTS(SELECT 1 FROM terminal_tabs WHERE id=? AND task_id=?) ON CONFLICT(id) DO NOTHING`,
        params: [
          next.id,
          next.taskId,
          next.tabId,
          next.mode,
          computerId,
          to.tabId,
          from.id,
          next.tabId,
          next.taskId
        ]
      },
      {
        type: 'run',
        sql: `INSERT INTO chat_tab_bindings(tab_id,conversation_id) SELECT tab_id,id FROM chat_ownership WHERE id=? AND state<>'deleted' ON CONFLICT(tab_id) DO NOTHING`,
        params: [next.id]
      },
      {
        type: 'run',
        sql: `INSERT INTO chat_bootstrap_reservations SELECT id,?,epoch FROM chat_ownership WHERE id=? AND state='legacy' AND computer_id IS NULL AND destination_computer_id=? ON CONFLICT(conversation_id) DO NOTHING`,
        params: [computerId, next.id, computerId]
      },
      {
        type: 'run',
        sql: `UPDATE chat_provider_transitions SET state='complete' WHERE id=? AND EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id=?) AND EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id=?)`,
        params: [value.id, to.tabId, from.id, next.tabId, next.id]
      }
    ])
    const archived = await ownership.forTab(to.tabId)
    const selected = await ownership.forTab(next.tabId)
    if (
      archived?.id !== from.id ||
      archived.epoch !== to.epoch ||
      selected?.id !== next.id ||
      selected.state === 'deleted'
    )
      throw new Error('Chat tab was deleted or changed during provider transition')
    // The tab now holds another conversation: access granted to the old one ends.
    notifyChatOwnershipChange(db, [from.tabId])
  }
  async function run(row: TransitionRow) {
    const owner = await ownership.get(row.conversation_id)
    if (!owner || owner.state === 'deleted') {
      await db.run("UPDATE chat_provider_transitions SET state='complete' WHERE id=?", [row.id])
      return
    }
    await opts.gate?.(row.computer_id, row.task_id)
    const value = proof(row, owner)
    if (owner.tabId === row.archive_tab_id && owner.epoch === row.epoch + 1)
      return publish(value, row.computer_id)
    if (
      owner.tabId !== row.tab_id ||
      owner.epoch !== row.epoch ||
      owner.computerId !== row.computer_id
    )
      throw new Error('Provider transition ownership changed')
    await opts.quiesce?.(owner)
    const identity = (await opts.request(row.computer_id, {
      kind: 'conversation.transition',
      value
    })) as ChatTabTransition['to']
    if (
      !identity ||
      ['id', 'taskId', 'tabId', 'mode', 'epoch'].some(
        (key) => identity[key as keyof typeof identity] !== value.to[key as keyof typeof identity]
      )
    )
      throw new Error('Invalid provider transition acknowledgement')
    await publish(value, row.computer_id)
  }
  return {
    settle(tabId: string) {
      return pending.get(tabId)
    },
    async ensure(owner: HubChatOwnership, mode: string) {
      const existing = pending.get(owner.tabId)
      if (existing) return existing
      const work = (async () => {
        if (!owner.computerId || owner.state !== 'active' || owner.cleanupPending)
          throw new Error('Chat history must finish migration before changing provider')
        const tab = await db.get<{ mode: string }>(
          'SELECT mode FROM terminal_tabs WHERE id=? AND task_id=?',
          [owner.tabId, owner.taskId]
        )
        if (!tab) throw new Error('Chat tab was deleted')
        if (chatStorageMode(tab.mode) === owner.mode) return
        const prior = await db.get<TransitionRow>(
          "SELECT * FROM chat_provider_transitions WHERE conversation_id=? AND state='reserved'",
          [owner.id]
        )
        if (prior) return run(prior)
        const from = {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch: owner.epoch
        }
        const value: ChatTabTransition = {
          id: randomUUID(),
          from,
          to: { ...from, tabId: randomUUID(), epoch: from.epoch + 1 },
          next: { id: randomUUID(), taskId: from.taskId, tabId: from.tabId, mode, epoch: 1 }
        }
        await reserve(value, owner.computerId)
        await run(
          (await db.get<TransitionRow>('SELECT * FROM chat_provider_transitions WHERE id=?', [
            value.id
          ]))!
        )
      })().finally(() => pending.delete(owner.tabId))
      pending.set(owner.tabId, work)
      return work
    },
    async resume(computerId: string) {
      for (const row of await db.all<TransitionRow>(
        "SELECT * FROM chat_provider_transitions WHERE computer_id=? AND state='reserved' ORDER BY epoch,id",
        [computerId]
      ))
        await run(row)
    },
    async recover(
      computerId: string,
      identity: ChatTabTransition['to'],
      transitions: ChatTabTransition[]
    ) {
      const sorted = transitions
        .map((value) => chatTabTransitionSchema.parse(value))
        .sort((a, b) => a.from.epoch - b.from.epoch)
      for (const value of sorted) {
        if (
          value.from.id !== identity.id ||
          value.from.taskId !== identity.taskId ||
          value.to.id !== identity.id ||
          value.to.taskId !== identity.taskId ||
          value.from.mode !== identity.mode ||
          value.to.mode !== identity.mode ||
          value.to.epoch !== value.from.epoch + 1 ||
          value.to.epoch > identity.epoch ||
          value.next.taskId !== identity.taskId ||
          value.next.tabId !== value.from.tabId ||
          value.next.epoch !== 1 ||
          value.next.mode === value.from.mode
        )
          throw new Error('Invalid provider transition recovery proof')
        const current = await ownership.get(identity.id)
        if (current?.state === 'deleted') return
        if (current && current.epoch >= value.to.epoch) continue
        if (
          current &&
          (current.tabId !== value.from.tabId ||
            current.epoch !== value.from.epoch ||
            current.computerId !== computerId ||
            current.taskId !== identity.taskId ||
            current.mode !== identity.mode)
        )
          throw new Error('Provider transition conflicts with active ownership')
        if (!current) {
          const tab = await db.get('SELECT 1 FROM terminal_tabs WHERE id=? AND task_id=?', [
            value.from.tabId,
            identity.taskId
          ])
          if (!tab) continue
          await ownership.register({ ...value.from, computerId })
        }
        await opts.gate?.(computerId, identity.taskId)
        const known = await db.get('SELECT 1 FROM chat_provider_transitions WHERE id=?', [value.id])
        await reserve(value, computerId)
        await publish(value, computerId, !known)
      }
      const last = sorted.at(-1)
      if (last && (last.to.tabId !== identity.tabId || last.to.epoch !== identity.epoch))
        throw new Error('Provider transition inventory does not match its proof')
    }
  }
}
