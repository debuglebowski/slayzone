import type { Database } from 'better-sqlite3'
import type { TxnRegistry } from '@slayzone/platform'
import { domainTxnRegistry, assertNoDuplicateTxnKeys } from '@slayzone/transport/txns'
import { exportImportTxns } from '../export-import-txns'
import { resetForTestTxns } from './reset-for-test-txn'

/**
 * Registry of named transactions executed inside the DB worker. A named txn is
 * a conditional read-modify-write that can't be shipped as a static op list
 * (e.g. "read MAX(position), then insert at +1"; "read existing id, then
 * upsert"). Each entry owns its own `db.transaction(...)` where atomicity is
 * needed, so the worker invokes it directly without re-wrapping.
 *
 * The domain half lives in `@slayzone/transport/txns` (shared with the
 * standalone `@slayzone/hub` side-car, which dispatches against it
 * directly). This file adds the two app-only sources — their impls and call
 * sites live in `apps/app`, which the shared packages can't import. To add a
 * new named txn: export it from the owning domain's `./db`, augment
 * `TxnRegistry` there, and spread it into the transport composition.
 */

// Domain-internal collisions are asserted inside @slayzone/transport/txns at
// its module load; this guards app-only keys colliding with domain keys.
assertNoDuplicateTxnKeys([domainTxnRegistry, exportImportTxns, resetForTestTxns])

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
  ...domainTxnRegistry,
  ...exportImportTxns,
  ...resetForTestTxns
} satisfies { [K in keyof TxnRegistry]: (db: Database, p: Parameters<TxnRegistry[K]>[0]) => unknown }
