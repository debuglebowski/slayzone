/**
 * The git panel's batched reads through the hub: ONE request to a computer that
 * answers them (`gitPanelReads`); for an older computer the hub composes the same
 * answer from the single ops it knows (panel-reads.ts), overlapping what it can.
 *
 * @module worktrees/server/panel-reads-routing
 */
import type { SlayzoneDb } from '@slayzone/platform'
import type { GitOpInput } from '../shared/git-ops-contract'
import type { BranchGraphRead, GitSummary } from '../shared/types'
import { executeGitOp, gitComputerSupports } from './git-op-routing'
import { readBranchGraph, readGitSummary, type PanelReadOps } from './panel-reads'
import type { WorktreesComputerTarget } from './worktrees-router-deps'

type Routed<T> = T & { target?: WorktreesComputerTarget }

/** Each single read as its own routed op on the scope's computer. */
function routedOps(target: WorktreesComputerTarget | undefined, db: SlayzoneDb): PanelReadOps {
  return {
    isGitRepo: (path) => executeGitOp('isGitRepo', { path, target }, false, db),
    getCurrentBranch: (path) => executeGitOp('getCurrentBranch', { path, target }, false, db),
    getRemoteUrl: (path) => executeGitOp('getRemoteUrl', { path, target }, false, db),
    getStatusSummary: (repoPath) =>
      executeGitOp('getStatusSummary', { repoPath, target }, false, db),
    getAheadBehindUpstream: (path, branch) =>
      executeGitOp('getAheadBehindUpstream', { path, branch, target }, false, db),
    resolveChildBranches: (path, baseBranch) =>
      executeGitOp('resolveChildBranches', { path, baseBranch, target }, false, db),
    getResolvedCommitDag: (path, limit, branches, baseBranch) =>
      executeGitOp('getResolvedCommitDag', { path, limit, branches, baseBranch, target }, false, db)
  }
}

export async function getGitSummaryRouted(
  { target, ...input }: Routed<GitOpInput<'getGitSummary'>>,
  db: SlayzoneDb
): Promise<GitSummary> {
  if (!(await gitComputerSupports(target, 'gitPanelReads')))
    return readGitSummary(routedOps(target, db), input, { overlap: true })
  try {
    return await executeGitOp('getGitSummary', { ...input, target }, false, db)
  } catch (err) {
    // The request itself failed (refused, the computer gone, timed out): as the repo
    // check failing did before it was batched — shown as the panel's git error.
    return { kind: 'checkFailed', message: err instanceof Error ? err.message : String(err) }
  }
}

export async function getBranchGraphRouted(
  { target, ...input }: Routed<GitOpInput<'getBranchGraph'>>,
  db: SlayzoneDb
): Promise<BranchGraphRead> {
  if (!(await gitComputerSupports(target, 'gitPanelReads')))
    return readBranchGraph(routedOps(target, db), input)
  return executeGitOp('getBranchGraph', { ...input, target }, false, db)
}
