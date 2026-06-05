import type { Database } from 'better-sqlite3'
import type { TxnRegistry } from '@slayzone/platform'
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
 * never its node-pty/electron-laden `/main` barrel. Each domain also augments
 * the `TxnRegistry` type map from its `*-txns.ts` module (declaration merging),
 * which is what gives `db.namedTxn(...)` its per-name param/return types. To add
 * a new named txn: export it from the domain's `./db`, augment `TxnRegistry`
 * there, and spread it in below.
 */

// Two domains accidentally registering the same key would be silently merged by
// object spread (last write wins). Catch it at module load instead — the source
// objects are still distinct here, before they collapse into one. (The type-map
// only errors on a duplicate key with a *different* signature, so this guards
// the same-signature case too.)
function assertNoDuplicateTxnKeys(sources: readonly Record<string, unknown>[]): void {
  const seen = new Set<string>()
  for (const src of sources) {
    for (const key of Object.keys(src)) {
      if (seen.has(key)) {
        throw new Error(`Duplicate named transaction key registered by two domains: "${key}"`)
      }
      seen.add(key)
    }
  }
}

assertNoDuplicateTxnKeys([
  chatQueueTxns,
  taskTxns,
  artifactsTxns,
  templatesTxns,
  artifactTxns,
  integrationTxns,
  tagsTxns,
  projectsTxns,
  automationsTxns,
  marketplaceTxns,
  exportImportTxns,
  resetForTestTxns
])

/**
 * `satisfies` against the augmented `TxnRegistry` map enforces completeness:
 * every name declared in the type map must have a runtime impl spread in here
 * (forgetting the spread after augmenting the type is a compile error).
 *
 * The explicit `Record<...>` annotation is what the worker dispatch indexes by a
 * runtime string; it also keeps the *exported* type nameable/portable under
 * `composite` (the precise inferred type names dozens of per-domain param types
 * this file never imports — TS2883). The `satisfies` still runs on the literal,
 * so completeness/correctness is checked before the annotation widens it.
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
} satisfies { [K in keyof TxnRegistry]: (db: Database, p: Parameters<TxnRegistry[K]>[0]) => unknown }
