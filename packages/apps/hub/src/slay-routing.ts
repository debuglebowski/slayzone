/** Routes the two machine-local Slay operations using workspace placement. */
import type { SlayExecutor, SlayTarget } from '@slayzone/ai-config/server'
import {
  HubToComputerMethods,
  slayCheckResultSchema,
  slaySetupResultSchema
} from '@slayzone/computer-transport/shared'

interface RoutingDeps {
  resolveComputer(target: SlayTarget): Promise<string | null>
  gateway: { request(computerId: string, method: string, params: unknown): Promise<unknown> }
  gate?: (computerId: string) => Promise<void>
  local: {
    checkSlayConfigured(path: string): boolean
    setupSlay(path: string, projectId?: string): { ok: boolean; error?: string }
  }
}
export function createRoutingSlayExecutor({
  resolveComputer,
  gateway,
  gate,
  local
}: RoutingDeps): SlayExecutor {
  async function request(target: SlayTarget, method: string): Promise<unknown> {
    const computerId = await resolveComputer(target)
    if (computerId == null) {
      return method === HubToComputerMethods.slaySetup
        ? local.setupSlay(target.projectPath, target.projectId)
        : { configured: local.checkSlayConfigured(target.projectPath) }
    }
    await gate?.(computerId)
    return gateway.request(computerId, method, {
      projectPath: target.projectPath,
      ...(target.projectId ? { projectId: target.projectId } : {})
    })
  }
  return {
    checkConfigured: async (input) =>
      slayCheckResultSchema.parse(await request(input, HubToComputerMethods.slayCheckConfigured))
        .configured,
    setup: async (input) =>
      slaySetupResultSchema.parse(await request(input, HubToComputerMethods.slaySetup))
  }
}
