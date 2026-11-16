import { WorkspaceSnapshotManager, workspaceGitEnv } from '@slayzone/agent-turns/workspace-capture'
import {
  HubToComputerMethods,
  workspaceCaptureParamsSchema
} from '@slayzone/computer-transport/shared'
import { judgePath } from '../path-jail'
import { execCapture } from './exec'
import type { HandlerContext, HubMethodTable } from './types'
import type { ProjectPathStore } from '../project-paths'

/** The Git work the handlers delegate to; tests inject it, the computer runs the real one. */
export interface WorkspaceChangesDeps {
  /** Takes and diffs the workspace snapshots. */
  captures: Pick<WorkspaceSnapshotManager, 'begin' | 'finish' | 'discard'>
  /** The Git work tree `cwd` belongs to (Git can walk up to a parent), or null if none. */
  gitToplevel: (cwd: string) => Promise<string | null>
}

async function gitToplevel(cwd: string): Promise<string | null> {
  const top = await execCapture('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    env: workspaceGitEnv(),
    timeoutMs: 1000
  })
  return top.status === 0 ? top.stdout.trim() : null
}

export function createWorkspaceChangesHandlers(
  ctx: HandlerContext,
  getProjects: () => ProjectPathStore | null,
  deps: WorkspaceChangesDeps = { captures: new WorkspaceSnapshotManager(), gitToplevel }
): HubMethodTable {
  const { captures } = deps
  const allowed = (path: string) => judgePath(path, ctx.config.allowedRoots)
  async function request(raw: unknown) {
    const parsed = workspaceCaptureParamsSchema.parse(raw)
    const path =
      parsed.rootPath || (parsed.projectId ? getProjects()?.get(parsed.projectId)?.path : null)
    if (!path) throw new Error('Workspace folder is unavailable on this computer.')
    const rootPath = allowed(path)
    // Git can walk to a parent repository. Validate that root too before snapshotting its files.
    const top = await deps.gitToplevel(rootPath)
    if (top === null) throw new Error('Workspace is not an accessible Git repository.')
    return { ...parsed, rootPath: allowed(top) }
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
