import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openChatStorage, type ChatStorage } from './storage'
import { createChatTransfers, encodeTransfer } from './transfers'
import {
  createSessionMoves,
  sessionLedgerMoveImport,
  type SessionMoveExport
} from './session-moves'

const dirs: string[] = []
const stores: ChatStorage[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** One computer's store for one hub. */
function computer(hubScope: string) {
  const root = mkdtempSync(join(tmpdir(), 'slz-session-move-'))
  dirs.push(root)
  const store = openChatStorage({ stateDir: root, hubScope })
  stores.push(store)
  return { store, transfers: createChatTransfers(store), moves: createSessionMoves(store) }
}
type Computer = ReturnType<typeof computer>

const TASK = 'task-1'
const identity = (id: string, epoch = 1, tabId = `tab-${id}`) => ({
  id,
  taskId: TASK,
  tabId,
  mode: 'claude-chat',
  epoch
})

function chat(c: Computer, id: string, texts: string[], epoch = 1, tabId?: string) {
  c.store.createConversation(identity(id, epoch, tabId))
  texts.forEach((text, i) =>
    c.store.append(id, epoch, { kind: 'assistant-text', messageId: `m${i}`, text }, 1000 + i)
  )
}

function ledgerRows(c: Computer, extra: { conversationId: string; cwd?: string }) {
  c.store.compose((db) => {
    db.prepare(
      `INSERT INTO agent_sessions (id, mode, cwd, task_id, tab_id, conversation_id, origin, status, created_at, bound_at)
       VALUES ('s1','claude-chat',?,?,?,?,'chat','bound',10,11)`
    ).run(extra.cwd ?? '/old/folder', TASK, `tab-${extra.conversationId}`, extra.conversationId)
    db.prepare(
      `INSERT INTO task_conversations (id, task_id, mode, tab_id, conversation_id, origin, created_at)
       VALUES ('tc1',?,'claude-chat',?,?,'chat',12)`
    ).run(TASK, `tab-${extra.conversationId}`, extra.conversationId)
    db.prepare('INSERT INTO session_turns(conversation_id, first_turn_at) VALUES(?,13)').run(
      extra.conversationId
    )
    db.prepare(
      `INSERT INTO provider_configs(task_id, mode, revision, value) VALUES(?, 'claude-chat', 4, ?)`
    ).run(TASK, JSON.stringify({ chatConversationId: 'cli-session-1', chatModel: 'm' }))
  })
}

/** What the app does: read each transfer in chunks from the source, write it to the target. */
function carry(from: Computer, to: Computer, moveId: string, exported: SessionMoveExport) {
  for (const manifest of exported.transfers) {
    const begun = to.transfers.begin(manifest)
    let offset = begun.offset
    for (;;) {
      const data = from.moves.read(moveId, manifest.header.identity.id, offset, 100)
      if (!data) break
      const bytes = Buffer.from(data, 'base64')
      to.transfers.chunk(begun.id, offset, bytes)
      offset += bytes.length
    }
    const staged = to.transfers.finish(begun.id)
    to.store.activate(staged.id, manifest.header.migrationId, staged.epoch, manifest.hash)
  }
  to.store.transaction(() =>
    sessionLedgerMoveImport.apply(to.store, {
      key: `ledger:${moveId}`,
      taskId: TASK,
      value: exported.ledger
    })
  )
}

const events = (c: Computer, id: string) =>
  c.store.read(id, -1).map((e) => (e.event as { text: string }).text)

describe('a task’s sessions leaving a computer', () => {
  test('the chats arrive whole and active, one epoch up; the source chat is untouched', () => {
    const A = computer('hub-a')
    const B = computer('hub-b')
    chat(A, 'c1', ['one', 'two', 'three'])
    chat(A, 'c2', ['other'], 1, 'tab-2')
    ledgerRows(A, { conversationId: 'c1' })

    const exported = A.moves.exportTask('move-1', TASK)
    expect(exported.transfers.map((t) => t.header.identity.id)).toEqual(['c1', 'c2'])
    expect(exported.transfers.every((t) => t.header.move === true)).toBe(true)
    // The export froze each chat only for the read.
    expect(A.store.conversation('c1')).toMatchObject({ state: 'active', migrationId: null })

    carry(A, B, 'move-1', exported)
    expect(events(B, 'c1')).toEqual(['one', 'two', 'three'])
    expect(events(B, 'c2')).toEqual(['other'])
    expect(B.store.conversation('c1')).toMatchObject({
      state: 'active',
      identity: { taskId: TASK, tabId: 'tab-c1', epoch: 2 }
    })
    // Still usable on the source: the task can move back, or the move can be canceled.
    expect(A.store.conversation('c1')).toMatchObject({ state: 'active', identity: { epoch: 1 } })
    expect(events(A, 'c1')).toEqual(['one', 'two', 'three'])
  })

  test('the ledger comes along, without paths, and a provider config keeps its session id', () => {
    const A = computer('hub-a')
    const B = computer('hub-b')
    chat(A, 'c1', ['one'])
    ledgerRows(A, { conversationId: 'c1' })
    const exported = A.moves.exportTask('move-1', TASK)
    carry(A, B, 'move-1', exported)

    B.store.compose((db) => {
      expect(
        db.prepare('SELECT id, cwd, status, conversation_id FROM agent_sessions').all()
      ).toEqual([{ id: 's1', cwd: null, status: 'bound', conversation_id: 'c1' }])
      expect(db.prepare('SELECT id FROM task_conversations').all()).toEqual([{ id: 'tc1' }])
      expect(db.prepare('SELECT conversation_id FROM session_turns').all()).toEqual([
        { conversation_id: 'c1' }
      ])
      const config = db
        .prepare('SELECT revision, value FROM provider_configs WHERE task_id = ?')
        .get(TASK) as { revision: number; value: string }
      expect(JSON.parse(config.value)).toEqual({
        chatConversationId: 'cli-session-1',
        chatModel: 'm'
      })
    })
  })

  test('the export is repeatable: a retry answers what the first did, not what changed since', () => {
    const A = computer('hub-a')
    chat(A, 'c1', ['one'])
    const first = A.moves.exportTask('move-1', TASK)
    A.store.append('c1', 1, { kind: 'assistant-text', messageId: 'late', text: 'late' }, 2000)
    expect(A.moves.exportTask('move-1', TASK)).toEqual(first)
    // A later move of the same task is a new export.
    const later = A.moves.exportTask('move-2', TASK)
    expect(later.transfers[0].header.events).toBe(2)
  })

  test('chats that are deleted, and the artifact store, are not exported', () => {
    const A = computer('hub-a')
    chat(A, 'kept', ['x'])
    chat(A, 'gone', ['y'], 1, 'tab-gone')
    A.store.deleteConversation('gone', 2)
    chat(A, 'files', ['z'], 1, 'artifact-store:task-1')
    expect(A.moves.exportTask('move-1', TASK).transfers.map((t) => t.header.identity.id)).toEqual([
      'kept'
    ])
  })

  test('a task coming back replaces the older copy this store kept; the ledger follows', () => {
    const A = computer('hub-a')
    const B = computer('hub-b')
    chat(A, 'c1', ['before'])
    ledgerRows(A, { conversationId: 'c1' })
    carry(A, B, 'out', A.moves.exportTask('out', TASK))
    // The task lives on B for a while: its chat grows there, its session ends.
    B.store.append('c1', 2, { kind: 'assistant-text', messageId: 'm9', text: 'on hub B' }, 5000)
    B.store.compose((db) =>
      db.prepare("UPDATE agent_sessions SET status = 'dead', ended_at = 99 WHERE id = 's1'").run()
    )

    carry(B, A, 'back', B.moves.exportTask('back', TASK))
    expect(events(A, 'c1')).toEqual(['before', 'on hub B'])
    expect(A.store.conversation('c1')).toMatchObject({ state: 'active', identity: { epoch: 3 } })
    A.store.compose((db) =>
      expect(db.prepare('SELECT status, ended_at FROM agent_sessions').all()).toEqual([
        { status: 'dead', ended_at: 99 }
      ])
    )
  })

  test('a plain transfer still refuses to overwrite a chat this store holds', () => {
    const A = computer('hub-a')
    const B = computer('hub-b')
    chat(B, 'c1', ['already here'])
    chat(A, 'c1', ['incoming'])
    A.store.freeze('c1', 1, 'plain')
    // Not a move's export (no `move` flag in its header).
    const plain = encodeTransfer(A.store.exportConversation('c1', 1, 'plain'))
    const begun = B.transfers.begin(plain.manifest)
    B.transfers.chunk(begun.id, 0, plain.bytes)
    expect(() => B.transfers.finish(begun.id)).toThrow(/overwrite/)
    expect(events(B, 'c1')).toEqual(['already here'])
  })

  test('a move never replaces a chat of another tab, or one that is not older', () => {
    const A = computer('hub-a')
    const B = computer('hub-b')
    chat(A, 'c1', ['a'])
    chat(B, 'c1', ['b'], 1, 'a-different-tab')
    const exported = A.moves.exportTask('m', TASK)
    const begun = B.transfers.begin(exported.transfers[0])
    let offset = 0
    for (;;) {
      const data = A.moves.read('m', 'c1', offset, 4096)
      if (!data) break
      const bytes = Buffer.from(data, 'base64')
      B.transfers.chunk(begun.id, offset, bytes)
      offset += bytes.length
    }
    expect(() => B.transfers.finish(begun.id)).toThrow(/overwrite/)
    expect(events(B, 'c1')).toEqual(['b'])
  })

  test('read answers nothing past the end; an unknown move or a bad id is refused', () => {
    const A = computer('hub-a')
    chat(A, 'c1', ['x'])
    const exported = A.moves.exportTask('m', TASK)
    const size = exported.transfers[0].bytes
    expect(A.moves.read('m', 'c1', size, 10)).toBe('')
    expect(() => A.moves.read('nope', 'c1', 0, 10)).toThrow(/Unknown session export/)
    expect(() => A.moves.exportTask('../escape', TASK)).toThrow(/Invalid move id/)
    A.moves.discard('m')
    expect(() => A.moves.read('m', 'c1', 0, 10)).toThrow(/Unknown session export/)
  })

  test('forgetting a task’s sessions removes its chats and ledger, not another task’s, and leaves no tombstone', () => {
    const A = computer('hub-a')
    const B = computer('hub-b')
    chat(A, 'mine', ['one', 'two'])
    chat(A, 'files', ['store'], 1, 'artifact-store:task-1')
    ledgerRows(A, { conversationId: 'mine' })
    A.store.createConversation({
      id: 'other',
      taskId: 'task-2',
      tabId: 'tab-other',
      mode: 'claude-chat',
      epoch: 1
    })
    A.store.append('other', 1, { kind: 'assistant-text', messageId: 'o', text: 'not yours' }, 1)
    const exported = A.moves.exportTask('m', TASK)
    carry(A, B, 'm', exported)

    expect(A.moves.forgetTask(TASK)).toEqual(['tab-mine'])
    expect(A.store.conversation('mine')).toBeNull()
    expect(A.store.read('mine', -1)).toEqual([])
    // Another task's chat and the artifact store are untouched.
    expect(events(A, 'other')).toEqual(['not yours'])
    expect(A.store.conversation('files')).not.toBeNull()
    A.store.compose((db) => {
      for (const table of [
        'agent_sessions',
        'task_conversations',
        'provider_configs',
        'session_turns'
      ])
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    })
    // Not a deletion: the task is not tombstoned here, so its sessions can come back.
    expect(A.store.taskLifecycle(TASK).state).toBe('active')
    carry(B, A, 'back', B.moves.exportTask('back', TASK))
    expect(events(A, 'mine')).toEqual(['one', 'two'])
    // Repeating the forget changes nothing.
    expect(A.moves.forgetTask('nothing-here')).toEqual([])
  })
})
