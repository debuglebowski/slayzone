/**
 * Commit lists through the hub, bounded (FU1 S4). A computer that answers bounded
 * reads gives the commits since a ref in pages (`getCommitsSincePage`); the hub
 * assembles the whole list for `worktrees.getCommitsSince`, and builds the WHOLE
 * fork graph itself for `worktrees.getResolvedForkGraph` (same graph, same counts —
 * the hub → client reply is not a computer frame). An older computer gets the
 * whole-answer ops it knows.
 *
 * @module worktrees/server/commits-routing
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { collectPages } from '@slayzone/platform/bounded-reads'
import type { GitOpInput } from '../shared/git-ops-contract'
import type { CommitInfo, ForkGraphResult } from '../shared/types'
import { resolveForkGraph } from './fork-graph'
import { executeGitOp, gitComputerSupports } from './git-op-routing'
import type { WorktreesComputerTarget } from './worktrees-router-deps'

type Routed<T> = T & { target?: WorktreesComputerTarget }

/** Every commit since `sinceRef` on `branch` at `path`, read in pages. */
function pagedCommitsSince(
  path: string,
  sinceRef: string,
  branch: string,
  target: WorktreesComputerTarget | undefined,
  db: SlayzoneDb
): Promise<CommitInfo[]> {
  return collectPages((cursor) =>
    executeGitOp('getCommitsSincePage', { path, sinceRef, branch, cursor, target }, false, db)
  )
}

export async function getCommitsSinceRouted(
  input: Routed<GitOpInput<'getCommitsSince'>>,
  db: SlayzoneDb
): Promise<CommitInfo[]> {
  if (!(await gitComputerSupports(input.target, 'boundedReads')))
    return executeGitOp('getCommitsSince', input, false, db)
  return pagedCommitsSince(input.path, input.sinceRef, input.branch, input.target, db)
}

export async function getResolvedForkGraphRouted(
  input: Routed<GitOpInput<'getResolvedForkGraph'>>,
  db: SlayzoneDb
): Promise<ForkGraphResult | null> {
  if (!(await gitComputerSupports(input.target, 'boundedReads')))
    return executeGitOp('getResolvedForkGraph', input, false, db)
  const { target } = input
  // As the computer's `getResolvedForkGraph`, step by step.
  const mergeBase = await executeGitOp(
    'getMergeBase',
    { path: input.repoPath, branch1: input.activeBranch, branch2: input.compareBranch, target },
    false,
    db
  )
  if (!mergeBase) return null
  const [baseCommits, featureCommits, preFork] = await Promise.all([
    pagedCommitsSince(input.repoPath, mergeBase, input.compareBranch, target, db),
    pagedCommitsSince(input.targetPath, mergeBase, input.activeBranch, target, db),
    executeGitOp(
      'getCommitsBeforeRef',
      { path: input.repoPath, ref: mergeBase, count: 3, target },
      false,
      db
    )
  ])
  return {
    graph: resolveForkGraph({
      baseBranchCommits: baseCommits,
      baseBranchName: input.compareBranchLabel,
      featureBranchCommits: featureCommits,
      featureBranchName: input.activeBranchLabel,
      forkPoint: mergeBase,
      preForkCommits: preFork
    }),
    forkPoint: mergeBase,
    featureCount: featureCommits.length,
    baseCount: baseCommits.length
  }
}

/** As the computer's `getResolvedUpstreamGraph`: the fork graph against `<branch>@{upstream}`. */
export async function getResolvedUpstreamGraphRouted(
  input: Routed<GitOpInput<'getResolvedUpstreamGraph'>>,
  db: SlayzoneDb
): Promise<ForkGraphResult | null> {
  if (!(await gitComputerSupports(input.target, 'boundedReads')))
    return executeGitOp('getResolvedUpstreamGraph', input, false, db)
  return getResolvedForkGraphRouted(
    {
      targetPath: input.repoPath,
      repoPath: input.repoPath,
      activeBranch: input.branch,
      compareBranch: `${input.branch}@{upstream}`,
      activeBranchLabel: input.branch,
      compareBranchLabel: `origin/${input.branch}`,
      target: input.target
    },
    db
  )
}
