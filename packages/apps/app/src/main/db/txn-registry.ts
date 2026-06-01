import type { Database } from 'better-sqlite3'
import { chatQueueTxns } from '@slayzone/terminal/db'
import { taskTxns, artifactsTxns, templatesTxns } from '@slayzone/task/db'
import { artifactTxns } from '@slayzone/task-artifacts/db'
import { integrationTxns } from '@slayzone/integrations/db'
import { tagsTxns } from '@slayzone/tags/db'
import { projectsTxns } from '@slayzone/projects/db'
import { automationsTxns } from '@slayzone/automations/db'
import { marketplaceTxns } from '@slayzone/ai-config/db'
import { exportImportTxns } from '../export-import-txns'
import { resetForTestTxns } from './reset-for-test-txn'

/**
 * Registry of named transactions executed inside the DB worker. A named txn is
 * a conditional read-modify-write that can't be shipped as a static op list
 * (e.g. "read MAX(position), then insert at +1"; "read existing id, then
 * upsert"). Each entry owns its own `db.transaction(...)` where atomicity is
 * needed, so the worker invokes it directly without re-wrapping.
 *
 * Logic lives in the owning domain (colocated with its other code) and is
 * surfaced here only through that domain's narrow, worker-safe `./db` entry —
 * never its node-pty/electron-laden `/main` barrel. To add a new named txn:
 * export it from the domain's `./db` and spread it in below.
 */
export const txnRegistry: Record<string, (db: Database, params: never) => unknown> = {
  ...chatQueueTxns,
  ...taskTxns,
  ...artifactsTxns,
  ...templatesTxns,
  ...artifactTxns,
  ...integrationTxns,
  ...tagsTxns,
  ...projectsTxns,
  ...automationsTxns,
  ...marketplaceTxns,
  ...exportImportTxns,
  ...resetForTestTxns
}
