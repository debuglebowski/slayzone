/**
 * v203: per-item fault ledger (`item_faults`).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v203-item-faults-migration.test.ts
 */
import Database from 'better-sqlite3'
import { createSyncFaultLedger, ITEM_FAULTS_DDL } from '@slayzone/platform/isolation'
import { describe, expect, test } from 'vitest'
import { staleContentErasureFences } from './content-erasure-fences'
import { migrations, runMigrations } from './index'

describe('v203: item_faults', () => {
  test('frozen DDL matches the live ledger DDL', () => {
    const v203 = migrations.find((m) => m.version === 203)
    expect(v203?.up.toString()).toContain(ITEM_FAULTS_DDL.replaceAll('`', ''))
  })

  test('ledger round-trip; erased tasks cannot gain faults', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    expect(staleContentErasureFences(db)).toEqual([])
    const ledger = createSyncFaultLedger(db, { origin: 'hub', computerId: 'pc' })
    const err = new Error('boom')
    ledger.record({ pass: 'p', itemKey: 'k', taskId: 't', kind: 'transient', error: err }, 100)
    expect(ledger.allows('p', 'k', null, 101)).toBe(false)
    expect(db.prepare('SELECT attempts, task_id, computer_id FROM item_faults').get()).toEqual({
      attempts: 1,
      task_id: 't',
      computer_id: 'pc'
    })
    ledger.clear('p', 'k')
    expect(db.prepare('SELECT COUNT(*) n FROM item_faults').get()).toEqual({ n: 0 })

    db.exec(`INSERT INTO content_erasure_jobs(id,scope,manifest,db_erased) VALUES('j','{}','{}',1);
      INSERT INTO content_erasure_tasks(task_id,job_id) VALUES('gone','j');`)
    expect(() =>
      db.exec(
        `INSERT INTO item_faults VALUES('hub','pc','p','k2','gone','transient',NULL,'m',1,0,0,NULL)`
      )
    ).toThrow('Content was permanently erased')
    // The ledger drops it instead of failing the pass.
    ledger.record({ pass: 'p', itemKey: 'k2', taskId: 'gone', kind: 'transient', error: err }, 0)
    expect(db.prepare('SELECT COUNT(*) n FROM item_faults').get()).toEqual({ n: 0 })
  })
})
