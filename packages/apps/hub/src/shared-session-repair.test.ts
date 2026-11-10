import { expect, test } from 'vitest'
import type { DiagnosticEvent } from '@slayzone/diagnostics/shared'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore, createSessionLedgerHarness } from '@slayzone/chat-runtime/server'
import { setTaskSessionLedger } from '@slayzone/task/server'
import { repairSharedSessionClaims } from './shared-session-repair'

/**
 * Boot repair for one task per provider session (#172 follow-up #4): every
 * provider session claimed by more than one task is kept in one task and
 * tombstoned (`session_deletions`, reversible) in the others, so a later delete
 * in the winner can never resurface it in a loser. A chat owner holding the
 * session picks the winner — it is the side driving the transcript; otherwise the
 * earliest claim does, the same rule the readers apply.
 *
 * The claims are a computer's (its session ledger, robustness plan §9); the
 * tombstones are the hub's intent, delivered to it.
 */
async function setup() {
  const h = await createTestHarness()
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  for (const id of ['task-a', 'task-b', 'task-c'])
    h.db.prepare('INSERT INTO tasks(id,project_id,title) VALUES(?,?,?)').run(id, 'p', id)
  const computer = createSessionLedgerHarness({ db: h.slayDb })
  setTaskSessionLedger(computer.ledger)
  const claim = (taskId: string, session: string, at: number, mode = 'claude-code') =>
    computer.service.handle({
      op: 'recordConversation',
      args: { taskId, mode, conversationId: session, origin: 'legacy-migration', createdAt: at }
    })
  const current = (taskId: string) =>
    computer.ledger.store.getCurrentConversationId(computer.computerId, taskId, 'claude-code')
  const tombstones = () =>
    h.db
      .prepare(
        'SELECT task_id,mode,conversation_id FROM session_deletions ORDER BY task_id,mode,conversation_id'
      )
      .all()
  const events: DiagnosticEvent[] = []
  const repair = () =>
    repairSharedSessionClaims({
      db: h.slayDb,
      record: (e) => events.push(e),
      ledger: computer.ledger,
      computerId: computer.computerId
    })
  const cleanup = () => {
    computer.close()
    h.cleanup()
  }
  /** A chat of `taskId` on the computer holding `session` (its own session record). */
  const chatHolds = (conversationId: string, taskId: string, tabId: string, session: string) => {
    computer.storage.createConversation({
      id: conversationId,
      taskId,
      tabId,
      mode: 'claude-chat',
      epoch: 1
    })
    computer.storage.putRecord(conversationId, 1, {
      kind: 'settings',
      id: `session:${JSON.stringify(['claude-chat', session])}`,
      value: { mode: 'claude-chat', conversationId: session, origin: 'handoff' },
      at: 1
    })
  }
  return { h, claim, tombstones, events, repair, current, cleanup, chatHolds }
}

test('the earliest claimant keeps a shared session; every other claim is tombstoned, once', async () => {
  const { h, claim, tombstones, events, repair, current, cleanup } = await setup()
  try {
    await claim('task-a', 'shared', 1)
    await claim('task-b', 'shared', 2)
    await claim('task-c', 'shared', 3, 'claude-chat')
    await claim('task-a', 'solo', 1)

    expect(await repair()).toEqual([
      {
        conversationId: 'shared',
        winner: 'task-a',
        via: 'earliest-claim',
        relinquished: [
          { taskId: 'task-b', mode: 'claude-code' },
          { taskId: 'task-c', mode: 'claude-chat' }
        ]
      }
    ])
    expect(tombstones()).toEqual([
      { task_id: 'task-b', mode: 'claude-code', conversation_id: 'shared' },
      { task_id: 'task-c', mode: 'claude-chat', conversation_id: 'shared' }
    ])
    expect(events).toEqual([
      expect.objectContaining({
        event: 'conv_id.shared_session_repaired',
        message: 'shared',
        payload: expect.objectContaining({ winner: 'task-a', via: 'earliest-claim' })
      })
    ])
    // Idempotent: nothing left to repair.
    expect(await repair()).toEqual([])
    expect(tombstones()).toHaveLength(2)

    // The winner later deleting it must not hand it to a loser.
    h.db
      .prepare(
        "INSERT INTO session_deletions(id,task_id,mode,conversation_id,created_at) VALUES('d','task-a','claude-code','shared',9)"
      )
      .run()
    expect(await current('task-b')).toBeNull()
  } finally {
    cleanup()
  }
})

test('the chat holding the session on the computer picks the winner, even over an earlier claim', async () => {
  const { h, claim, tombstones, repair, current, cleanup, chatHolds } = await setup()
  try {
    await claim('task-a', 'shared', 1)
    await claim('task-b', 'shared', 2)
    // Task B's chat holds the transcript (bound before the fix shipped).
    const ownership = createChatOwnershipStore(h.slayDb)
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('chat-b','task-b','claude-chat',0)"
      )
      .run()
    await ownership.register({
      id: 'owner-b',
      taskId: 'task-b',
      tabId: 'chat-b',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    chatHolds('owner-b', 'task-b', 'chat-b', 'shared')

    expect(await repair()).toEqual([
      {
        conversationId: 'shared',
        winner: 'task-b',
        via: 'chat-binding',
        relinquished: [{ taskId: 'task-a', mode: 'claude-code' }]
      }
    ])
    expect(tombstones()).toEqual([
      { task_id: 'task-a', mode: 'claude-code', conversation_id: 'shared' }
    ])
    // Readers now agree with the binding.
    expect(await current('task-b')).toBe('shared')
    expect(await current('task-a')).toBeNull()
  } finally {
    cleanup()
  }
})
