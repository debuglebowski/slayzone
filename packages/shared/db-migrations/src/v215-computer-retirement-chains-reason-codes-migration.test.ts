/**
 * v215 (two repairs for "one answer about a removed computer", post-v0.39 review):
 *
 * 1. Retirement chains collapse. A retirement names its final successor, or none: a
 *    computer re-enrolled as one later re-enrolled again names the last; one whose
 *    successor was deleted (or went missing) is removed for good, with that reason.
 *    Every single-row check (SQL and code) then reads a chain right. A cycle names no
 *    live computer: removed ('missing').
 * 2. A chat's unavailable reason is a code (`computer-removed` | `not-returned`), the
 *    text lives in one place (terminal-contracts). The two texts the hub ever stored
 *    (v0.39.0) become their codes; any other text reads as `not-returned`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v215-computer-retirement-chains-reason-codes-migration.test.ts
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

function upgraded(seed: string): Database.Database {
  const db = new Database(':memory:')
  runRange(db, 0, 214)
  db.exec(seed)
  runRange(db, 214, 215)
  return db
}

test('retirement chains collapse to their final successor, or to removed with its reason', () => {
  const db = upgraded(`
    INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at) VALUES
      ('a','b','re-enrolled',1),('b','c','re-enrolled',2),
      ('x','y','re-enrolled',1),('y','z','re-enrolled',2),('z',NULL,'deleted',3),
      ('m','n','re-enrolled',1),('n',NULL,'missing',2),
      ('k','l','re-enrolled',1),('l','k','re-enrolled',2),
      ('solo',NULL,'deleted',1);`)
  expect(
    db
      .prepare(
        'SELECT computer_id,successor_id,reason,retired_at FROM computer_retirements ORDER BY computer_id'
      )
      .all()
  ).toEqual([
    { computer_id: 'a', successor_id: 'c', reason: 're-enrolled', retired_at: 1 },
    { computer_id: 'b', successor_id: 'c', reason: 're-enrolled', retired_at: 2 },
    { computer_id: 'k', successor_id: null, reason: 'missing', retired_at: 1 },
    { computer_id: 'l', successor_id: null, reason: 'missing', retired_at: 2 },
    { computer_id: 'm', successor_id: null, reason: 'missing', retired_at: 1 },
    { computer_id: 'n', successor_id: null, reason: 'missing', retired_at: 2 },
    { computer_id: 'solo', successor_id: null, reason: 'deleted', retired_at: 1 },
    { computer_id: 'x', successor_id: null, reason: 'deleted', retired_at: 1 },
    { computer_id: 'y', successor_id: null, reason: 'deleted', retired_at: 2 },
    { computer_id: 'z', successor_id: null, reason: 'deleted', retired_at: 3 }
  ])
})

test("a chat's stored unavailable reason becomes its code", () => {
  const db = upgraded(`
    INSERT INTO projects(id,name,color) VALUES('p','P','#000');
    INSERT INTO tasks(id,project_id,title) VALUES('t','p','T');
    INSERT INTO chat_ownership(id,task_id,tab_id,mode,epoch,state,computer_id) VALUES
      ('removed','t','tab1','claude-chat',1,'active','gone'),
      ('missing','t','tab2','claude-chat',1,'active','pc'),
      ('other','t','tab3','claude-chat',1,'active','pc');
    INSERT INTO chat_unavailable_owners(conversation_id,computer_id,epoch,reason) VALUES
      ('removed','gone',1,'Chat history unavailable. Its computer was removed. Connect a computer that holds this chat (e.g. the same machine re-enrolled with its chat data) to restore it.'),
      ('missing','pc',1,'Chat history unavailable. Computer did not return this conversation. Restore its chat backup or reconnect the original computer; no empty history was created.'),
      ('other','pc',1,'some other text');`)
  expect(
    db.prepare('SELECT conversation_id,reason FROM chat_unavailable_owners ORDER BY 1').all()
  ).toEqual([
    { conversation_id: 'missing', reason: 'not-returned' },
    // Only the two texts above were ever written (v0.39.0): any other is the generic one.
    { conversation_id: 'other', reason: 'not-returned' },
    { conversation_id: 'removed', reason: 'computer-removed' }
  ])
})
