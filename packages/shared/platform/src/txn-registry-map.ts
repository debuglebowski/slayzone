import type { Database } from 'better-sqlite3'

/**
 * The type-level registry of named transactions. Each domain augments this
 * interface from its own `*-txns.ts` module via declaration merging:
 *
 *   declare module '@slayzone/platform' {
 *     interface TxnRegistry extends TxnSigOf<typeof tagsTxns> {}
 *   }
 *
 * Because the augmentation is projected from the impl object (`typeof xTxns`),
 * the map can never drift from the implementations — the `*Txns` object is the
 * single source of truth. `namedTxn` keys off this interface so call sites get
 * exact param + return types, names rename-propagate, and a key collision
 * between two domains surfaces as a compile error (an interface can't merge the
 * same key with two different signatures).
 *
 * Lives in the lowest-layer platform package so `SlayzoneDb.namedTxn` can
 * reference it without platform depending on any domain (the call sites live in
 * the domains; the dependency would otherwise be a cycle). Declaration merging
 * is the only way to type the in-domain call sites without that cycle.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- open for domain augmentation
export interface TxnRegistry {}

/**
 * Projects an impl object `{ name: (db, params) => result }` into the map shape
 * `{ name: (params) => result }`. The second branch handles no-param txns
 * (`(db) => result`), which would otherwise fall through to `never`.
 */
export type TxnSigOf<T> = {
  [K in keyof T]: T[K] extends (db: Database, p: infer P) => infer R
    ? (p: P) => R
    : T[K] extends (db: Database) => infer R
      ? (p?: Record<string, never>) => R
      : never
}

/**
 * Surfaced (as the expected type of `namedTxn`'s `name` arg) when the
 * `TxnRegistry` augmentation is NOT present in the current compilation — i.e.
 * this package's tsconfig doesn't reach the central aggregator. Declaration
 * merging is per-compilation, so a package that type-checks `db.namedTxn(...)`
 * call sites must include the aggregator; otherwise `keyof TxnRegistry`
 * collapses to `never` and every call fails with an opaque "not assignable to
 * 'never'". Branding the empty case turns that into the actual remedy, so the
 * cross-package delivery requirement is self-documenting at the error site
 * instead of being tribal knowledge.
 */
type AugmentationNotLoaded =
  'TxnRegistry augmentation not loaded in this compilation: add "packages/shared/types/src/txn-registry.d.ts" (or the global.d.ts that references it) to this package tsconfig "include"'

/** A registered transaction name (or a loud remedy if the map isn't loaded). */
export type TxnName = [keyof TxnRegistry] extends [never] ? AugmentationNotLoaded : keyof TxnRegistry

/** The params type for a given transaction name. */
export type TxnParams<K extends TxnName> = K extends keyof TxnRegistry
  ? Parameters<TxnRegistry[K]>[0]
  : never

/** The (possibly-sync) result type for a given transaction name. */
export type TxnResult<K extends TxnName> = K extends keyof TxnRegistry
  ? ReturnType<TxnRegistry[K]>
  : never
