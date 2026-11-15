/**
 * The fork graph of two branches from their commits (pure): what
 * `getResolvedForkGraph` answers, built on the computer from whole lists or on the
 * hub from a bounded computer's pages (FU1 S4).
 *
 * @module worktrees/server/fork-graph
 */
import type { CommitInfo, ResolvedCommit, ResolvedGraph } from '../shared/types'

export function resolveForkGraph(opts: {
  baseBranchCommits: CommitInfo[]
  baseBranchName: string
  featureBranchCommits: CommitInfo[]
  featureBranchName: string
  forkPoint: string
  preForkCommits: CommitInfo[]
}): ResolvedGraph {
  const resolved: ResolvedCommit[] = []
  const baseBranch = opts.baseBranchName
  const featureBranch = opts.featureBranchName

  // Base branch commits
  for (let i = 0; i < opts.baseBranchCommits.length; i++) {
    const c = opts.baseBranchCommits[i]
    resolved.push({
      ...c,
      parents: [],
      branch: baseBranch,
      branchRefs: i === 0 ? [baseBranch] : [],
      tags: [],
      isBranchTip: i === 0,
      isHead: false
    })
  }

  // Feature branch commits
  for (let i = 0; i < opts.featureBranchCommits.length; i++) {
    const c = opts.featureBranchCommits[i]
    resolved.push({
      ...c,
      parents: [],
      branch: featureBranch,
      branchRefs: i === 0 ? [featureBranch] : [],
      tags: [],
      isBranchTip: i === 0,
      isHead: false
    })
  }

  // Fork point
  resolved.push({
    hash: opts.forkPoint,
    shortHash: opts.forkPoint.slice(0, 7),
    message: 'fork point',
    author: '',
    relativeDate: '',
    parents: [],
    branch: baseBranch,
    branchRefs: [],
    tags: [],
    isBranchTip: false,
    isHead: false
  })

  // Pre-fork context commits
  for (const c of opts.preForkCommits) {
    resolved.push({
      ...c,
      parents: [],
      branch: baseBranch,
      branchRefs: [],
      tags: [],
      isBranchTip: false,
      isHead: false
    })
  }

  const branches = opts.featureBranchCommits.length > 0 ? [baseBranch, featureBranch] : [baseBranch]

  return { commits: resolved, baseBranch, branches }
}
