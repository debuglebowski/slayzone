import type { Database } from 'better-sqlite3'

/**
 * The type-level registry of named transactions. Each `*Txns` impl object types
 * its own names with an augmentation right below it, in the same module:
 *
 *   declare module '@slayzone/platform' {
 *     interface TxnRegistry extends TxnSigOf<typeof tagsTxns> {}
 *   }
 *
 * and every file that calls one of those txns imports that module, type-only:
 *
 *   import type {} from './tags-txns'
 *
 * Declaration merging is per program: an augmentation types `namedTxn` only in a
 * program that loads its file. A call site is type-checked in its own package's
 * program and in the program of every package that imports it (packages export
 * their source), so the call site itself brings the augmentation along — any
 * program that checks a call also loads the txns it calls, and no package has to
 * load the txns of domains it does not depend on (its typecheck stays hermetic,
 * `pnpm lint:tsconfig-hermetic`).
 *
 * Because the augmentation is projected from the impl object (`typeof xTxns`),
 * the map can never drift from the implementations — the `*Txns` object is the
 * single source of truth. `namedTxn` keys off this interface so call sites get
 * exact param + return types, names rename-propagate, and a key collision
 * between two domains surfaces as a compile error (an interface can't merge the
 * same key with two different signatures) in any program that loads both.
 *
 * Lives in the lowest-layer platform package so `SlayzoneDb.namedTxn` can
 * reference it without platform depending on any domain (the call sites live in
 * the domains; the dependency would otherwise be a cycle). Declaration merging
 * is the only way to type the in-domain call sites without that cycle.
 */
// Empty on purpose: open for domain augmentation.
export interface TxnRegistry {}

/**
 * Projects an impl object `{ name: (db, params) => result }` into the map shape
 * `{ name: (params) => result }`, keeping the params' optionality. A no-params
 * txn (`(db) => result`) takes `{}` or nothing — and nothing else.
 */
export type TxnSigOf<T> = {
  [K in keyof T]: T[K] extends (db: Database, ...params: infer P) => infer R
    ? P extends []
      ? (p?: Record<string, never>) => R
      : (...params: P) => R
    : never
}

/**
 * Surfaced (as the expected type of `namedTxn`'s `name` arg) when NO `TxnRegistry`
 * augmentation is loaded in the current program — the file calling
 * `db.namedTxn(...)` does not import the module that defines the txn. Without the
 * brand `keyof TxnRegistry` collapses to `never` and every call fails with an
 * opaque "not assignable to 'never'"; the brand names the remedy at the error site.
 */
type AugmentationNotLoaded =
  'TxnRegistry augmentation not loaded in this program: the file calling db.namedTxn(...) must `import type {} from` the module whose `*Txns` object defines the txn'

/** A registered transaction name (or a loud remedy if the map isn't loaded). */
export type TxnName = [keyof TxnRegistry] extends [never]
  ? AugmentationNotLoaded
  : keyof TxnRegistry

/** The params type for a given transaction name. */
export type TxnParams<K extends TxnName> = K extends keyof TxnRegistry
  ? Parameters<TxnRegistry[K]>[0]
  : never

/** The (possibly-sync) result type for a given transaction name. */
export type TxnResult<K extends TxnName> = K extends keyof TxnRegistry
  ? ReturnType<TxnRegistry[K]>
  : never
