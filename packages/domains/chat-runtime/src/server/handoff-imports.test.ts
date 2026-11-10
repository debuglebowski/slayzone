/**
 * The hub's staged rows reach the computer once (`data.import`, computer-data-handoff)
 * — for every kind, an item applies, a second delivery changes nothing, and a row
 * this computer already has is never overwritten by the older hub copy:
 *   - `task-conversation` (v206): the provenance trail a resume reads;
 *   - `legacy-conversation-history` (v206): the pre-ledger session list the healer
 *     repoints to (a bug here means a fresh session after upgrade, not a resume);
 *   - `chat-settings` (v205): an owned chat's settings the computer may not hold.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { chatSettingsImport } from './chat-settings-import'
import { sessionLedgerImports } from './session-ledger-imports'
import { openChatStorage } from './storage'
import { createComputerTaskData } from './task-data'

const roots: string[] = []
const stores: Array<ReturnType<typeof openChatStorage>> = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function open() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slz-handoff-imports-')))
  roots.push(dir)
  const storage = openChatStorage({ stateDir: dir, hubScope: 'hub' })
  stores.push(storage)
  const data = createComputerTaskData({
    storage,
    computerId: 'pc',
    imports: { ...sessionLedgerImports, 'chat-settings': chatSettingsImport },
    providerConfig: () => ({})
  })
  return { storage, data }
}

describe('task-conversation hand-off', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'tc1',
    taskId: 't',
    mode: 'claude-code',
    tabId: 't',
    conversationId: 'HUB',
    origin: 'slay-spawned-fresh',
    pendingMeta: null,
    createdAt: 10,
    ...over
  })
  const read = (storage: ReturnType<typeof open>['storage']) =>
    storage.compose((db) =>
      db.prepare('SELECT id, task_id, conversation_id, origin FROM task_conversations').all()
    )

  test('applies once and keeps a row already here', () => {
    const { storage, data } = open()
    const batch = { kind: 'task-conversation', items: [{ key: 'tc1', taskId: 't', value: row() }] }
    expect(data.importBatch(batch).applied).toEqual(['tc1'])
    expect(data.importBatch(batch).applied).toEqual(['tc1'])
    expect(read(storage)).toEqual([
      { id: 'tc1', task_id: 't', conversation_id: 'HUB', origin: 'slay-spawned-fresh' }
    ])
    storage.compose((db) =>
      db.prepare("UPDATE task_conversations SET conversation_id='LOCAL' WHERE id='tc1'").run()
    )
    data.importBatch(batch)
    expect(read(storage)).toMatchObject([{ conversation_id: 'LOCAL' }])
  })

  test('a row naming another task is rejected on its own (quarantined); the rest applies', () => {
    const { storage, data } = open()
    const result = data.importBatch({
      kind: 'task-conversation',
      items: [
        { key: 'tc1', taskId: 't', value: row() },
        { key: 'tc2', taskId: 't', value: row({ id: 'tc2', taskId: 'other' }) }
      ]
    })
    expect(result.applied).toEqual(['tc1'])
    expect(result.rejected).toEqual([{ key: 'tc2', message: 'Conversation row of another task' }])
    expect(read(storage)).toMatchObject([{ id: 'tc1' }])
  })

  test('an invalid value is rejected on its own', () => {
    const { data } = open()
    const result = data.importBatch({
      kind: 'task-conversation',
      items: [
        { key: 'tc1', taskId: 't', value: row() },
        { key: 'bad', taskId: 't', value: row({ id: '' }) }
      ]
    })
    expect(result.applied).toEqual(['tc1'])
    expect(result.rejected.map((r) => r.key)).toEqual(['bad'])
  })
})

describe('legacy-conversation-history hand-off', () => {
  const ids = (storage: ReturnType<typeof open>['storage']) =>
    (
      storage.compose((db) =>
        db
          .prepare("SELECT ids FROM legacy_conversation_history WHERE task_id='t' AND mode='codex'")
          .get()
      ) as { ids: string } | undefined
    )?.ids

  test('merges into the list already here, without duplicates, idempotently', () => {
    const { storage, data } = open()
    const batch = (list: string[]) => ({
      kind: 'legacy-conversation-history',
      items: [{ key: 't:codex', taskId: 't', value: { mode: 'codex', ids: list } }]
    })
    expect(data.importBatch(batch(['A', 'B'])).applied).toEqual(['t:codex'])
    expect(JSON.parse(ids(storage)!)).toEqual(['A', 'B'])
    data.importBatch(batch(['A', 'B']))
    expect(JSON.parse(ids(storage)!)).toEqual(['A', 'B'])
    data.importBatch(batch(['B', 'C']))
    expect(JSON.parse(ids(storage)!)).toEqual(['A', 'B', 'C'])
  })

  test('an invalid list is rejected on its own', () => {
    const { data } = open()
    const result = data.importBatch({
      kind: 'legacy-conversation-history',
      items: [{ key: 't:codex', taskId: 't', value: { mode: 'codex', ids: [''] } }]
    })
    expect(result.rejected.map((r) => r.key)).toEqual(['t:codex'])
  })
})

describe('chat-settings hand-off (S6)', () => {
  const config = (storage: ReturnType<typeof open>['storage']) =>
    storage.compose(
      (db) =>
        db
          .prepare(
            "SELECT value, revision FROM provider_configs WHERE task_id='t' AND mode='claude-chat'"
          )
          .get() as { value: string; revision: number } | undefined
    )
  const batch = (settings: Record<string, unknown>) => ({
    kind: 'chat-settings',
    items: [{ key: 't:claude-chat', taskId: 't', value: { mode: 'claude-chat', settings } }]
  })

  test('fills only settings this computer lacks; its own values win', () => {
    const { storage, data } = open()
    storage.compose((db) =>
      db
        .prepare("INSERT INTO provider_configs VALUES('t','claude-chat',2,?)")
        .run(JSON.stringify({ chatModel: 'local-model', flags: '--f' }))
    )
    expect(
      data.importBatch(batch({ chatMode: 'auto-accept', chatModel: 'hub-model' })).applied
    ).toEqual(['t:claude-chat'])
    const after = config(storage)!
    expect(JSON.parse(after.value)).toEqual({
      chatModel: 'local-model',
      flags: '--f',
      chatMode: 'auto-accept'
    })
    expect(after.revision).toBe(3)
    // Delivered again: nothing changes (not even the revision).
    data.importBatch(batch({ chatMode: 'auto-accept', chatModel: 'hub-model' }))
    expect(config(storage)!.revision).toBe(3)
  })

  test('no configuration here yet: held as the seed the first read starts from', () => {
    const { storage, data } = open()
    data.importBatch(batch({ chatMode: 'auto-accept' }))
    expect(config(storage)).toBeUndefined()
    expect(
      storage.compose((db) =>
        db
          .prepare(
            "SELECT value FROM provider_config_seeds WHERE task_id='t' AND mode='claude-chat'"
          )
          .get()
      )
    ).toEqual({ value: JSON.stringify({ chatMode: 'auto-accept' }) })
  })

  test('only known chat settings are taken', () => {
    const { data } = open()
    const result = data.importBatch(batch({ chatConversationId: 'X' }))
    expect(result.rejected.map((r) => r.key)).toEqual(['t:claude-chat'])
  })
})
