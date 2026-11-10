/**
 * v208: the hub keeps no provider bindings (`chat_provider_bindings`) and no
 * per-message queue routes (`chat_queue_routes`) — robustness plan §9, P0. Which chat
 * holds a provider session is its computer's answer (`chatSessionOwner`); a queued
 * message is reached through its tab. The metadata cursor and receipts stay: they
 * still guard the hub-owned caches (file locations, agent state, activity).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v208-drop-provider-bindings-queue-routes-migration.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from './index'

function runRange(db: Database.Database, from: number, to: number): void {
  for (const m of migrations)
    if (m.version > from && m.version <= to)
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
}

const tables = (db: Database.Database) =>
  new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
  )

test('drops provider bindings and queue routes; keeps the metadata cursor and receipts', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 207)
    db.exec(`
      INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
      INSERT INTO tasks (id, project_id, title) VALUES ('t', 'p', 'T');
      INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES ('tab', 't', 'claude-chat', 0);
      INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state)
        VALUES ('c', 't', 'tab', 'claude-chat', 'pc', 1, 'active');
      INSERT INTO chat_provider_bindings VALUES ('native', 'claude-code', 'c');
      INSERT INTO chat_queue_routes (id, tab_id, conversation_id) VALUES ('q', 'tab', 'c');
      INSERT INTO chat_metadata_progress (conversation_id, sequence, store_id) VALUES ('c', 4, 's');
      INSERT INTO chat_metadata_receipts (conversation_id, operation_id, sequence) VALUES ('c', 'op', 4);
    `)
    runRange(db, 207, 208)
    const after = tables(db)
    expect(after.has('chat_provider_bindings')).toBe(false)
    expect(after.has('chat_queue_routes')).toBe(false)
    expect(db.prepare('SELECT sequence, store_id FROM chat_metadata_progress').all()).toEqual([
      { sequence: 4, store_id: 's' }
    ])
    expect(db.prepare('SELECT operation_id FROM chat_metadata_receipts').all()).toEqual([
      { operation_id: 'op' }
    ])
    // Erasure still deletes a task with chats (no trigger names the dropped tables).
    db.exec("DELETE FROM terminal_tabs WHERE id='tab'")
    db.exec("DELETE FROM tasks WHERE id='t'")
    expect(db.prepare("SELECT state FROM chat_ownership WHERE id='c'").get()).toEqual({
      state: 'deleted'
    })
  } finally {
    db.close()
  }
})
