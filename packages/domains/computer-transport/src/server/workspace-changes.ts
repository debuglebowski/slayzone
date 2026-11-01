import type { WorkspaceCaptureBackend, WorkspaceCaptureContext } from '@slayzone/terminal/server'
import {
  HubToComputerMethods,
  workspaceCaptureBeginSchema,
  workspaceCaptureResultSchema
} from '../shared'
import type { RoutingGateway } from './exec-proxies'

/** Uses the process's resolved computer ID. Never falls back to the hub's disk. */
export function createRoutingWorkspaceCaptureBackend(
  gateway: RoutingGateway
): WorkspaceCaptureBackend {
  const request = (ctx: WorkspaceCaptureContext, method: string) => {
    if (!ctx.computerId) return Promise.reject(new Error('Workspace computer is unavailable.'))
    return gateway.request(
      ctx.computerId,
      method,
      { id: ctx.id, scope: ctx.scope, rootPath: ctx.rootPath, projectId: ctx.projectId },
      6000
    )
  }
  return {
    begin: async (ctx) =>
      workspaceCaptureBeginSchema.parse(
        await request(ctx, HubToComputerMethods.workspaceChangesBegin)
      ),
    finish: async (ctx) =>
      workspaceCaptureResultSchema.parse(
        await request(ctx, HubToComputerMethods.workspaceChangesFinish)
      ),
    discard: async (ctx) => {
      await request(ctx, HubToComputerMethods.workspaceChangesDiscard)
    }
  }
}
