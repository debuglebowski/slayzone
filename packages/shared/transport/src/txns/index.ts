import { chatQueueTxns } from '@slayzone/terminal/db'
import { taskTxns, artifactsTxns, templatesTxns } from '@slayzone/task/db'
import { artifactTxns } from '@slayzone/task-artifacts/db'
import { integrationTxns } from '@slayzone/integrations/db'
import { tagsTxns } from '@slayzone/tags/db'
import { projectsTxns } from '@slayzone/projects/db'
import { automationsTxns } from '@slayzone/automations/db'
import { marketplaceTxns } from '@slayzone/ai-config/db'

/**
 * Domain half of the named-transaction registry — every txn whose impl lives
 * in a domain's worker-safe `./db` entry. Hosted here (electron-free, guard-
 * covered) so BOTH hosts compose it:
 *
 *  - the Electron app's DB worker (`apps/app/.../db/txn-registry.ts`) spreads
 *    this and adds its two app-only sources (export-import, reset-for-test);
 *  - the standalone `@slayzone/server` side-car dispatches `namedTxn` against
 *    it directly (app-only txns are deliberately absent there — their call
 *    sites live in `apps/app` only).
 *
 * Type-level: the central aggregator (`@slayzone/types` txn-registry.d.ts)
 * projects these same impl objects into `TxnRegistry`; `DomainTxnRegistry`
 * below stays a precise key-preserving type so the app registry's completeness
 * `satisfies` still sees every domain key through the re-export.
 */

/**
 * Two domains accidentally registering the same key would be silently merged by
 * object spread (last write wins). Catch it at module load instead — the source
 * objects are still distinct here, before they collapse into one. (The type-map
 * only errors on a duplicate key with a *different* signature, so this guards
 * the same-signature case too.)
 */
export function assertNoDuplicateTxnKeys(sources: readonly Record<string, unknown>[]): void {
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

const sources = [
  chatQueueTxns,
  taskTxns,
  artifactsTxns,
  templatesTxns,
  artifactTxns,
  integrationTxns,
  tagsTxns,
  projectsTxns,
  automationsTxns,
  marketplaceTxns
] as const

assertNoDuplicateTxnKeys(sources)

/**
 * Precise, nameable composition type (intersection of the imported impl-object
 * types). Annotating the export with it keeps the declaration portable under
 * `composite` (the raw inferred literal would name dozens of per-domain param
 * types this file never imports — TS2883) while preserving exact keys for the
 * app registry's completeness check.
 */
export type DomainTxnRegistry = typeof chatQueueTxns &
  typeof taskTxns &
  typeof artifactsTxns &
  typeof templatesTxns &
  typeof artifactTxns &
  typeof integrationTxns &
  typeof tagsTxns &
  typeof projectsTxns &
  typeof automationsTxns &
  typeof marketplaceTxns

export const domainTxnRegistry: DomainTxnRegistry = {
  ...chatQueueTxns,
  ...taskTxns,
  ...artifactsTxns,
  ...templatesTxns,
  ...artifactTxns,
  ...integrationTxns,
  ...tagsTxns,
  ...projectsTxns,
  ...automationsTxns,
  ...marketplaceTxns
}
