/**
 * v199: content-erasure fences reinstalled from one definition.
 *
 * v198 fenced `artifact_blob_pins` like content, so after an erasure the hub
 * could not rebuild a retained backup's pins (scope 'hub-backup') for the erased
 * task: the startup re-pin aborted with "Content was permanently erased", the
 * recovery guard lease stayed, and all artifact blob GC was deferred.
 *
 * Also guards the fence itself: every table with a task_id/tab_id column must
 * carry it, so a later migration (or table rebuild) cannot silently drop it.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v199-content-erasure-fences-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import {
  CONTENT_ERASURE_UNFENCED_TABLES,
  contentErasureFences,
  staleContentErasureFences
} from './content-erasure-fences'
import { LATEST_MIGRATION_VERSION, migrations, runMigrations } from './index'

const hash = 'a'.repeat(64)
const pin = (scope: string, owner: string) =>
  `INSERT INTO artifact_blob_pins VALUES('${scope}','${owner}','${owner}','${hash}','t','a',0,'${hash}',1)`

function atVersion(version: number) {
  const db = new Database(':memory:')
  for (const m of migrations) {
    if (m.version > version) break
    m.up(db)
    db.pragma(`user_version = ${m.version}`)
  }
  return db
}

function erasedTask(db: Database.Database) {
  db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
    INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task');
    INSERT INTO terminal_tabs(id,task_id,label,mode) VALUES('tab','t','Tab','terminal');
    INSERT INTO content_erasure_jobs(id,scope,manifest,db_erased) VALUES('j','{}','{}',1);
    INSERT INTO content_erasure_tasks(task_id,job_id) VALUES('t','j');
    INSERT INTO content_erasure_tabs(tab_id,job_id) VALUES('tab','j');`)
}

describe('v199: backup pins stay rebuildable for erased tasks', () => {
  test('v198 rejected them; v199 accepts backup pins and keeps fencing the rest', () => {
    const db = atVersion(198)
    erasedTask(db)
    expect(() => db.exec(pin('hub-backup', 'old.sqlite'))).toThrow('Content was permanently erased')

    runMigrations(db)
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_MIGRATION_VERSION)

    db.exec(pin('hub-backup', 'old.sqlite'))
    db.exec("UPDATE artifact_blob_pins SET size=2 WHERE scope='hub-backup'")
    expect(
      db.prepare("SELECT size FROM artifact_blob_pins WHERE scope='hub-backup'").get()
    ).toEqual({ size: 2 })
    // Live consumers would keep erased bytes forever: still fenced.
    expect(() => db.exec(pin('legacy-chat-migration', 'owner'))).toThrow(
      'Content was permanently erased'
    )
    expect(() =>
      db.exec(
        "UPDATE artifact_blob_pins SET scope='legacy-chat-migration' WHERE scope='hub-backup'"
      )
    ).toThrow('Content was permanently erased')
    // Content stays fenced, by task and by tab.
    expect(() =>
      db.exec("INSERT INTO task_artifacts(id,task_id,title) VALUES('a2','t','x')")
    ).toThrow('Content was permanently erased')
    expect(() => db.exec("INSERT INTO chat_tab_state(tab_id,updated_at) VALUES('tab',0)")).toThrow(
      'Content was permanently erased'
    )
    expect(staleContentErasureFences(db)).toEqual([])
  })
})

describe('content-erasure fence coverage', () => {
  test('a fresh database fences every table with task_id/tab_id', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    expect(staleContentErasureFences(db)).toEqual([])
    // The definition covers every such table except the documented allowlist.
    const fenced = new Set(contentErasureFences(db).map((f) => f.table))
    const owned = (
      db
        .prepare(
          `SELECT DISTINCT m.name FROM sqlite_master m, pragma_table_info(m.name) c
          WHERE m.type='table' AND c.name IN ('task_id','tab_id')`
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    for (const table of owned)
      if (!table.startsWith('content_erasure_') && !CONTENT_ERASURE_UNFENCED_TABLES.has(table))
        expect(fenced.has(table), table).toBe(true)
    expect(fenced.has('artifact_blob_pins')).toBe(true)
  })

  test('an upgraded database (v197 → latest) fences every table with task_id/tab_id', () => {
    const db = atVersion(197)
    runMigrations(db)
    expect(staleContentErasureFences(db)).toEqual([])
  })

  test('a table created or rebuilt after the fence install is reported', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    db.exec('CREATE TABLE future_content(id TEXT PRIMARY KEY, task_id TEXT, tab_id TEXT)')
    db.pragma('foreign_keys = OFF')
    db.exec(`ALTER TABLE task_tags RENAME TO task_tags_old;
      CREATE TABLE task_tags AS SELECT * FROM task_tags_old;
      DROP TABLE task_tags_old;`)
    expect(staleContentErasureFences(db).sort()).toEqual([
      'content_erasure_future_content_insert',
      'content_erasure_future_content_update',
      'content_erasure_task_tags_insert',
      'content_erasure_task_tags_update'
    ])
  })
})
