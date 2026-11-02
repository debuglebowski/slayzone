/** Check and initialize agent instructions on the machine owning the workspace. */
import { execFile } from 'node:child_process'
import { checkSlayConfigured } from '@slayzone/ai-config/slay-setup'
import { buildShellInvocation, quoteForShell } from '@slayzone/platform'
import { HubToComputerMethods, slayParamsSchema } from '@slayzone/computer-transport/shared'
import { assertPathAllowed } from '../config'
import type { HandlerContext, HubMethodTable } from './types'
import { buildSpawnEnv } from './spawn-env'

export function createSlayHandlers(ctx: HandlerContext): HubMethodTable {
  return {
    [HubToComputerMethods.slayCheckConfigured]: async (raw) => {
      const input = slayParamsSchema.parse(raw)
      const cwd = assertPathAllowed(input.projectPath, ctx.config.allowedRoots)
      return { configured: checkSlayConfigured(cwd) }
    },
    [HubToComputerMethods.slaySetup]: async (raw) => {
      const input = slayParamsSchema.parse(raw)
      const cwd = assertPathAllowed(input.projectPath, ctx.config.allowedRoots)
      const devFlag = process.env.NODE_ENV === 'development' ? ' --dev' : ''
      const projectFlag = input.projectId ? ` --project ${quoteForShell(input.projectId)}` : ''
      const { file, args } = buildShellInvocation(
        `slay${devFlag} init${projectFlag} --path ${quoteForShell(cwd)}`
      )
      const capability = ctx.cliRelay?.issue()
      try {
        return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          execFile(
            file,
            args,
            {
              cwd,
              timeout: 10_000,
              env: buildSpawnEnv(ctx, undefined, capability)
            },
            (err) => resolve(err ? { ok: false, error: err.message } : { ok: true })
          )
        })
      } finally {
        capability?.revoke()
      }
    }
  }
}
