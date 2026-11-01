import { WorkspaceSnapshotManager, workspaceGitEnv } from '@slayzone/agent-turns/workspace-capture'
import {
  HubToComputerMethods,
  workspaceCaptureParamsSchema
} from '@slayzone/computer-transport/shared'
import { assertPathAllowed } from '../config'
import { execCapture } from './exec'
import type { HandlerContext, HubMethodTable } from './types'
import type { ProjectPathStore } from '../project-paths'

export function createWorkspaceChangesHandlers(
  ctx: HandlerContext,
  getProjects: () => ProjectPathStore | null
): HubMethodTable {
  const captures = new WorkspaceSnapshotManager()
  const allowed = (path: string) => assertPathAllowed(path, ctx.config.allowedRoots)
  async function request(raw: unknown) {
    const parsed = workspaceCaptureParamsSchema.parse(raw)
    const path =
      parsed.rootPath || (parsed.projectId ? getProjects()?.get(parsed.projectId)?.path : null)
    if (!path) throw new Error('Workspace folder is unavailable on this computer.')
    const rootPath = allowed(path)
    // Git can walk to a parent repository. Validate that root too before snapshotting its files.
    const top = await execCapture('git', ['rev-parse', '--show-toplevel'], {
      cwd: rootPath,
      env: workspaceGitEnv(),
      timeoutMs: 1000
    })
    if (top.status !== 0) throw new Error('Workspace is not an accessible Git repository.')
    return { ...parsed, rootPath: allowed(top.stdout.trim()) }
  }
  return {
    [HubToComputerMethods.workspaceChangesBegin]: async (raw) => {
      const params = await request(raw)
      return { ...(await captures.begin(params)), rootPath: params.rootPath }
    },
    [HubToComputerMethods.workspaceChangesFinish]: async (raw) =>
      captures.finish(await request(raw)),
    [HubToComputerMethods.workspaceChangesDiscard]: async (raw) => {
      await captures.discard(await request(raw))
      return { ok: true }
    }
  }
}
