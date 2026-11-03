/**
 * `usage.collect`: this computer's agent usage logs, parsed here (the same parsers
 * the hub used on its own disk) from the hub's cursors. Reads only the agents' own
 * log dirs under this computer's home; answers records + the new cursors.
 *
 * @module computer/handlers/usage-collect
 */
import { HubToComputerMethods, usageCollectParamsSchema } from '@slayzone/computer-transport/shared'
import { collectUsage } from '@slayzone/usage-analytics/collect'
import type { HandlerContext, HubMethodTable } from './types'

export function createUsageCollectHandlers(_ctx: HandlerContext): HubMethodTable {
  async function usageCollect(raw: unknown): Promise<{ results: unknown[] }> {
    const { cursors } = usageCollectParamsSchema.parse(raw)
    return { results: await collectUsage(cursors) }
  }
  return { [HubToComputerMethods.usageCollect]: usageCollect }
}
