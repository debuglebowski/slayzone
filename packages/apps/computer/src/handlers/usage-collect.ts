/**
 * `usage.collect`: this computer's agent usage logs, parsed here (the same parsers
 * the hub used on its own disk) from the read offsets THIS computer keeps (robustness
 * plan §9, P0; hub v209 — the hub keeps none). Reads only the agents' own log dirs
 * under this computer's home; answers the new records, paged, each page with a
 * receipt the hub acknowledges once stored — only then do its cursors move
 * (`@slayzone/usage-analytics/collect` collector.ts).
 *
 * Records of a session this computer's ledger names are attributed to its task here,
 * before they leave (the ledger is only here).
 *
 * @module computer/handlers/usage-collect
 */
import {
  HubToComputerMethods,
  usageCollectParamsSchema,
  type UsageCollectResult
} from '@slayzone/computer-transport/shared'
import {
  collectUsage,
  createUsageCollector,
  type ParseResult,
  type UsageCursors,
  type UsageCursorStore
} from '@slayzone/usage-analytics/collect'
import type { HandlerContext, HubMethodTable } from './types'

export { DEFAULT_PAGE_BYTES, pageUsage } from '@slayzone/usage-analytics/collect'

export function createUsageCollectHandlers(
  _ctx: HandlerContext,
  opts: {
    /**
     * This hub's cursor store (its chat store). Throws while the hub's runtime is
     * unavailable: the collect then fails, and the hub asks again next refresh.
     */
    cursors: () => UsageCursorStore
    pageBytes?: number
    collect?: typeof collectUsage
    /**
     * The task that ran each provider session, from this computer's session ledger
     * (robustness plan §9: only here). A record of a session it names is
     * attributed to that task before it leaves.
     */
    taskOf?: (sessionIds: string[]) => Record<string, string>
    /**
     * The task whose worktree each folder is, from this computer's task paths (§9
     * Phase 7c: only here). A record no session names is attributed by its folder.
     */
    taskOfCwd?: (cwds: string[]) => Record<string, string>
  }
): HubMethodTable {
  const collectRaw = opts.collect ?? collectUsage
  /** Attribute records `pick` keys to a task through `lookup`; no answer = unattributed. */
  const attribute = (
    results: ParseResult[],
    pick: (rec: ParseResult['records'][number]) => string | null | undefined,
    lookup: ((keys: string[]) => Record<string, string>) | undefined
  ) => {
    if (!lookup) return
    const keys = new Set<string>()
    for (const r of results)
      for (const rec of r.records) {
        const key = pick(rec)
        if (!rec.taskId && key) keys.add(key)
      }
    if (!keys.size) return
    let tasks: Record<string, string>
    try {
      tasks = lookup([...keys])
    } catch {
      // No store for this hub yet (its chat runtime is not up): unattributed.
      return
    }
    for (const r of results)
      for (const rec of r.records) {
        const key = pick(rec)
        if (!rec.taskId && key && tasks[key]) rec.taskId = tasks[key]
      }
  }
  const collect = async (cursors: UsageCursors): Promise<ParseResult[]> => {
    const results = await collectRaw(cursors)
    attribute(results, (rec) => rec.sessionId, opts.taskOf)
    attribute(results, (rec) => rec.cwd, opts.taskOfCwd)
    return results
  }
  const collector = createUsageCollector({
    store: opts.cursors,
    collect,
    pageBytes: opts.pageBytes
  })

  async function usageCollect(raw: unknown): Promise<UsageCollectResult> {
    const reply = await collector.handle(usageCollectParamsSchema.parse(raw))
    return reply as unknown as UsageCollectResult
  }
  return { [HubToComputerMethods.usageCollect]: usageCollect }
}
