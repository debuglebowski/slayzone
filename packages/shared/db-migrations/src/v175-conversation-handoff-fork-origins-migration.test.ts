/**
 * v175: the conversation ledger admits two more honored origins (chat A):
 *  - `handoff`: an existing conversation of the task moved between the terminal
 *    (TUI) and chat — the other mode's honored row names it.
 *  - `slay-spawned-fork`: a fork SlayZone spawned (`--fork-session`).
 * Both tables are rebuilt (a CHECK can't be altered in place); every row and
 * every index survives.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v175-conversation-handoff-fork-origins-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { migrations } from './index'

function dbUpTo(maxVersion: number): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.version > maxVersion) break
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return db
}

function runFrom(db: Database.Database, fromExclusive: number): void {
  for (const m of migrations) {
    if (m.version <= fromExclusive) continue
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
}

const insertConversation = (db: Database.Database, id: string, origin: string): void => {
  db.prepare(
    `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, created_at)
     VALUES (?, 't1', 'claude-chat', ?, ?, 1)`
  ).run(id, `conv-${id}`, origin)
}
const insertSession = (db: Database.Database, id: string, origin: string): void => {
  db.prepare(
    `INSERT INTO agent_sessions (id, mode, task_id, conversation_id, origin, status, created_at)
     VALUES (?, 'claude-chat', 't1', ?, ?, 'dead', 1)`
  ).run(id, `conv-${id}`, origin)
}
const indexes = (db: Database.Database, table: string): string[] =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name)

describe('v175 conversation origins: handoff + slay-spawned-fork', () => {
  test('before: refused; after: accepted in both tables; rows and indexes kept', () => {
    const db = dbUpTo(174)
    db.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'P', '#000')`).run()
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p1', 'T', 'todo')`
    ).run()
    insertConversation(db, 'old', 'slay-spawned-fresh')
    insertSession(db, 'old', 'user-selected')
    expect(() => insertConversation(db, 'h0', 'handoff')).toThrow(/CHECK/)
    expect(() => insertSession(db, 'f0', 'slay-spawned-fork')).toThrow(/CHECK/)
    const convIndexes = indexes(db, 'task_conversations')
    const sessionIndexes = indexes(db, 'agent_sessions')

    runFrom(db, 174)

    insertConversation(db, 'h1', 'handoff')
    insertConversation(db, 'f1', 'slay-spawned-fork')
    insertSession(db, 'h1', 'handoff')
    insertSession(db, 'f1', 'slay-spawned-fork')
    expect(() => insertConversation(db, 'x', 'made-up')).toThrow(/CHECK/)
    expect(db.prepare(`SELECT origin FROM task_conversations WHERE id = 'old'`).get()).toEqual({
      origin: 'slay-spawned-fresh'
    })
    expect(db.prepare(`SELECT origin FROM agent_sessions WHERE id = 'old'`).get()).toEqual({
      origin: 'user-selected'
    })
    expect(indexes(db, 'task_conversations')).toEqual(convIndexes)
    expect(indexes(db, 'agent_sessions')).toEqual(sessionIndexes)
  })
})
