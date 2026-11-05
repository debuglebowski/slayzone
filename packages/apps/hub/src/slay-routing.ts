/** Routes the two machine-local Slay operations using workspace placement. */
import type { SlayExecutor, SlayTarget } from '@slayzone/ai-config/server'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import {
  HubToComputerMethods,
  slayCheckResultSchema,
  slaySetupResultSchema
} from '@slayzone/computer-transport/shared'

interface RoutingDeps {
  resolveComputer(target: SlayTarget): Promise<string | null>
  /** Its owner check is the gateway's, for every request (G2). */
  gateway: { request(computerId: string, method: string, params: unknown): Promise<unknown> }
}
export function createRoutingSlayExecutor({ resolveComputer, gateway }: RoutingDeps): SlayExecutor {
  async function request(target: SlayTarget, method: string): Promise<unknown> {
    const computerId = await resolveComputer(target)
    // `slay` runs where the project is; the hub never runs it itself.
    if (computerId == null) refuseNoComputer({ op: method })
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
