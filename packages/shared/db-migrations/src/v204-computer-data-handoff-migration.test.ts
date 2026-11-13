/**
 * v204: `computer_data_handoff` — hub rows of computer-only data waiting to be
 * delivered to the computer that owns their task (robustness plan §9, P0).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v204-computer-data-handoff-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { staleContentErasureFences } from './content-erasure-fences'
import { runMigrations } from './index'

describe('v204: computer_data_handoff', () => {
  test('one row per (kind, item); erased tasks cannot gain rows', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    expect(staleContentErasureFences(db)).toEqual([])
    const insert = db.prepare(
      'INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at) VALUES(?,?,?,?,?)'
    )
    insert.run('k', 'a', 't1', '{}', 1)
    expect(() => insert.run('k', 'a', 't1', '{}', 2)).toThrow(/UNIQUE|PRIMARY/)
    insert.run('k2', 'a', 't1', '{}', 2)
    expect(db.prepare('SELECT COUNT(*) n FROM computer_data_handoff').get()).toEqual({ n: 2 })

    db.exec(`INSERT INTO content_erasure_jobs(id,scope,manifest,db_erased) VALUES('j','{}','{}',1);
      INSERT INTO content_erasure_tasks(task_id,job_id) VALUES('gone','j');`)
    expect(() => insert.run('k', 'b', 'gone', '{}', 3)).toThrow('Content was permanently erased')
  })
})
