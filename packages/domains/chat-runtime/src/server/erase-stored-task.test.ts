import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { finishStoredTaskErasure, prepareStoredTaskErasure } from './erase-stored-task'

function store() {
  const root = mkdtempSync(join(tmpdir(), 'stored-task-erasure-')),
    path = join(root, 'chat.sqlite'),
    db = new Database(path)
  db.pragma('journal_mode=WAL')
  db.pragma('secure_delete=ON')
  db.exec(`
    CREATE TABLE conversations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,tab_id TEXT NOT NULL,mode TEXT NOT NULL,
      epoch INTEGER NOT NULL,state TEXT NOT NULL,migration_id TEXT,migration_hash TEXT);
    CREATE TABLE events(conversation_id TEXT NOT NULL,seq INTEGER NOT NULL,saved_at INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(conversation_id,seq));
    CREATE TABLE records(conversation_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,saved_at INTEGER NOT NULL,PRIMARY KEY(conversation_id,kind,id));
    CREATE TABLE receipts(conversation_id TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(conversation_id,id));
    INSERT INTO conversations VALUES('c-alice','alice','tab','claude-chat',1,'active',NULL,NULL);
    INSERT INTO conversations VALUES('c-bob','bob','tab-b','claude-chat',1,'active',NULL,NULL);`)
  let vacuums = 0
  const exec = db.exec.bind(db)
  db.exec = ((sql: string) => {
    if (/^\s*VACUUM\b/i.test(sql)) vacuums++
    return exec(sql)
  }) as typeof db.exec
  const event = (conversation: string, seq: number, text: string) =>
    db.prepare('INSERT INTO events VALUES(?,?,1,?)').run(conversation, seq, text)
  return { root, path, db, vacuums: () => vacuums, event }
}

test('a repeated erase request for an already erased and compacted task does not VACUUM again', () => {
  const { root, path, db, vacuums, event } = store()
  const secret = 'COMPUTER-ERASURE-MARKER-9f02'
  try {
    event('c-alice', 1, secret.repeat(100))
    event('c-bob', 1, 'bob keeps this')
    prepareStoredTaskErasure(db, 'alice')
    finishStoredTaskErasure(db, root, 'alice')
    expect(vacuums()).toBe(1)
    for (const file of [path, path + '-wal'])
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false)
    // The hub re-sends after a lost reply, or an account erasure lists old tasks again.
    prepareStoredTaskErasure(db, 'alice')
    finishStoredTaskErasure(db, root, 'alice')
    expect(vacuums()).toBe(1)
    expect(db.prepare("SELECT event FROM events WHERE conversation_id='c-bob'").get()).toEqual({
      event: 'bob keeps this'
    })
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('content removed by another path between preparation and finish is still compacted', () => {
  const { root, db, vacuums, event } = store()
  try {
    event('c-alice', 1, 'first')
    prepareStoredTaskErasure(db, 'alice')
    finishStoredTaskErasure(db, root, 'alice')
    expect(vacuums()).toBe(1)
    // A restored copy brings content back; the lifecycle purge deletes it after the
    // preparation, so the finishing step itself deletes nothing.
    event('c-alice', 2, 'restored content')
    prepareStoredTaskErasure(db, 'alice')
    db.prepare("DELETE FROM events WHERE conversation_id='c-alice'").run()
    finishStoredTaskErasure(db, root, 'alice')
    expect(vacuums()).toBe(2)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
