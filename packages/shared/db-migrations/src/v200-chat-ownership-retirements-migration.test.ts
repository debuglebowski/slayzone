/**
 * v200: chat ownership robustness.
 * - pending = an unacknowledged deletion target exists (triggers + one-time repair);
 * - purges target the conversation's own computers, not only tracked task computers;
 * - provider transitions can be 'superseded';
 * - computer ids chat bookkeeping names but that no longer exist are retired,
 *   with no hardcoded exclusions (a not-yet-enrolled local computer only has
 *   placements, never chat references).
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { migrations, runMigrations } from './index'

function atVersion(version: number) {
  const db = new Database(':memory:')
  for (const m of migrations) {
    if (m.version > version) break
    m.up(db)
    db.pragma(`user_version = ${m.version}`)
  }
  return db
}

const owner = (id: string, task: string, tab: string, computer: string | null, state: string) =>
  `INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state) VALUES('${id}','${task}','${tab}','claude-chat',${
    computer ? `'${computer}'` : 'NULL'
  },1,'${state}')`

function seed(db: Database.Database) {
  db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
    INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'),('u','p','Other');
    INSERT INTO terminal_tabs(id,task_id,label,mode) VALUES('tab','t','Chat','claude-chat'),('tab2','u','Chat','claude-chat');
    INSERT INTO computers(id,name,platform,version,capabilities_json,created_at) VALUES('pc','pc','darwin','1','[]',0);`)
}

describe('v200', () => {
  test('repairs deleted chats pending with nothing to deliver', () => {
    const db = atVersion(199)
    seed(db)
    db.exec(`${owner('stuck', 't', 'gone-tab', null, 'deleted')};
      UPDATE chat_ownership SET cleanup_pending=1 WHERE id='stuck';
      ${owner('waiting', 't', 'gone-tab2', 'pc', 'deleted')};
      UPDATE chat_ownership SET cleanup_pending=1 WHERE id='waiting';
      INSERT INTO chat_deletion_targets VALUES('waiting','pc',1,0);`)
    runMigrations(db)
    const pending = db.prepare('SELECT cleanup_pending AS p FROM chat_ownership WHERE id=?')
    expect(pending.get('stuck')).toEqual({ p: 0 })
    expect(pending.get('waiting')).toEqual({ p: 1 })
    // Acknowledging the last target clears it, whoever writes the ack.
    db.exec("UPDATE chat_deletion_targets SET acknowledged=1 WHERE conversation_id='waiting'")
    expect(pending.get('waiting')).toEqual({ p: 0 })
  })

  test('purging a task whose chats name no tracked computer leaves nothing pending', () => {
    const db = atVersion(199)
    seed(db)
    runMigrations(db)
    db.exec(`${owner('legacy', 't', 'tab', null, 'legacy')};
      INSERT INTO chat_tab_bindings(tab_id,conversation_id) VALUES('tab','legacy');`)
    db.exec("DELETE FROM tasks WHERE id='t'")
    expect(
      db.prepare("SELECT state,cleanup_pending AS p FROM chat_ownership WHERE id='legacy'").get()
    ).toEqual({ state: 'deleted', p: 0 })
  })

  test('closing a tab targets the conversation it deletes, including its own computer', () => {
    const db = atVersion(199)
    seed(db)
    runMigrations(db)
    db.exec(`${owner('live', 'u', 'tab2', 'pc', 'active')};
      INSERT INTO chat_tab_bindings(tab_id,conversation_id) VALUES('tab2','live');
      DELETE FROM chat_task_computers;`)
    db.exec("DELETE FROM terminal_tabs WHERE id='tab2'")
    expect(
      db.prepare('SELECT conversation_id,computer_id,acknowledged FROM chat_deletion_targets').all()
    ).toEqual([{ conversation_id: 'live', computer_id: 'pc', acknowledged: 0 }])
    expect(
      db.prepare("SELECT cleanup_pending AS p FROM chat_ownership WHERE id='live'").get()
    ).toEqual({
      p: 1
    })
  })

  test('provider transitions accept superseded and keep one reserved per conversation', () => {
    const db = atVersion(199)
    seed(db)
    db.exec(`${owner('c', 't', 'tab', 'pc', 'active')};
      INSERT INTO chat_provider_transitions VALUES('x','c','t','tab','arch','next','codex-chat','pc',1,'reserved');`)
    runMigrations(db)
    db.exec("UPDATE chat_provider_transitions SET state='superseded' WHERE id='x'")
    db.exec(
      "INSERT INTO chat_provider_transitions VALUES('y','c','t','tab','arch2','next2','codex-chat','pc',1,'reserved')"
    )
    expect(() =>
      db.exec(
        "INSERT INTO chat_provider_transitions VALUES('z','c','t','tab','arch3','next3','codex-chat','pc',1,'reserved')"
      )
    ).toThrow(/UNIQUE/)
  })

  test('retires only computer ids that are gone everywhere', () => {
    const db = atVersion(199)
    seed(db)
    db.exec(`${owner('a', 't', 'tab', 'pc', 'active')};
      ${owner('b', 'u', 'tab2', 'gone', 'active')};
      INSERT INTO chat_deletion_targets VALUES('a','gone-too',1,0);
      INSERT INTO project_placements(computer_id,project_id,root_path,status,updated_at) VALUES('unenrolled-local','p','/x','active',0);
      INSERT INTO chat_legacy_tab_computers VALUES('legacy-tab','legacy-only');
      UPDATE tasks SET computer_id='bound' WHERE id='u';
      INSERT INTO chat_task_computers VALUES('u','bound');`)
    runMigrations(db)
    expect(
      db
        .prepare('SELECT computer_id,successor_id,reason FROM computer_retirements ORDER BY 1')
        .all()
    ).toEqual([
      { computer_id: 'gone', successor_id: null, reason: 'missing' },
      { computer_id: 'gone-too', successor_id: null, reason: 'missing' }
    ])
  })
})
