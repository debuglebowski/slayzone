/**
 * Central type augmentation for `db.namedTxn(...)`.
 *
 * Each domain owns its named-transaction *implementations* (the `*Txns` objects
 * exported from its worker-safe `./db` barrel and wired at runtime in
 * `apps/app/.../db/txn-registry.ts`). The *types* for those txns are projected
 * here, in one place, into the open `TxnRegistry` interface declared by
 * `@slayzone/platform`. `TxnSigOf<typeof xTxns>` maps each impl `(db, params) =>
 * result` to the call-shape `(params) => result`, so the map can never drift
 * from the implementations.
 *
 * Why here and not co-located in each domain: `db.namedTxn` call sites live
 * inside the domains, and a domain's call site is type-checked in *other*
 * packages' compilations too (whenever they import that domain). A co-located
 * `declare module` only enters its own package's program, so `keyof TxnRegistry`
 * would be incomplete cross-package. This file lives in `@slayzone/types` —
 * which already depends on every domain and whose `global.d.ts` every package's
 * tsconfig includes — and module specifiers resolve relative to THIS file's
 * location, so the augmentation is complete in every compilation. Pulled in via
 * a `/// <reference />` from `global.d.ts`.
 *
 * App-internal txns (`export-import:*`, `db:reset-for-test`) are NOT here —
 * they live in `apps/app`, which `@slayzone/types` can't import. They self-augment
 * co-located; their only call sites are in `apps/app`, whose program already
 * includes them via the runtime registry.
 */
import type { TxnSigOf } from '@slayzone/platform'
import type { chatQueueTxns } from '@slayzone/terminal/db'
import type { taskTxns, artifactsTxns, templatesTxns } from '@slayzone/task/db'
import type { artifactTxns } from '@slayzone/task-artifacts/db'
import type { integrationTxns } from '@slayzone/integrations/db'
import type { tagsTxns } from '@slayzone/tags/db'
import type { projectsTxns } from '@slayzone/projects/db'
import type { automationsTxns } from '@slayzone/automations/db'
import type { marketplaceTxns } from '@slayzone/ai-config/db'

declare module '@slayzone/platform' {
  interface TxnRegistry
    extends TxnSigOf<typeof chatQueueTxns>,
      TxnSigOf<typeof taskTxns>,
      TxnSigOf<typeof artifactsTxns>,
      TxnSigOf<typeof templatesTxns>,
      TxnSigOf<typeof artifactTxns>,
      TxnSigOf<typeof integrationTxns>,
      TxnSigOf<typeof tagsTxns>,
      TxnSigOf<typeof projectsTxns>,
      TxnSigOf<typeof automationsTxns>,
      TxnSigOf<typeof marketplaceTxns> {}
}
