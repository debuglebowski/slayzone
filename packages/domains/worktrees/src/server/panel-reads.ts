/**
 * The git panel's batched reads, composed ONCE over whatever runs the single reads:
 * the computer runs them on its own disk (`git-ops.ts`, one `git.op` request for the
 * whole chain), the hub runs them as routed single ops for a computer that predates
 * them (`panel-reads-routing.ts`). Same steps, same answer, either way.
 *
 * Why: each chain was a run of dependent requests from the renderer, so on a remote
 * hub or computer the panel waited out one round trip per step.
 *
 * Lean (bundled into the computer): no DB, Electron, React or tRPC.
 *
 * @module worktrees/server/panel-reads
 */
import type { GitOpInput } from '../shared/git-ops-contract'
import type {
  AheadBehind,
  BranchGraphRead,
  GitSummary,
  ResolvedGraph,
  StatusSummary
} from '../shared/types'

/** The single reads the batched ones are made of. */
export interface PanelReadOps {
  isGitRepo(path: string): Promise<boolean>
  getCurrentBranch(path: string): Promise<string | null>
  getRemoteUrl(path: string): Promise<string | null>
  getStatusSummary(repoPath: string): Promise<StatusSummary>
  getAheadBehindUpstream(path: string, branch: string): Promise<AheadBehind | null>
  resolveChildBranches(
    path: string,
    baseBranch: string
  ): Promise<{ children: string[]; merged: string[] }>
  getResolvedCommitDag(
    path: string,
    limit: number,
    branches: string[],
    baseBranch: string
  ): Promise<ResolvedGraph>
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The header's summary.
 *
 * `overlap`: start the reads alongside the repo check instead of after it (discarded
 * when it is no repo). Worth it where each read is a network round trip (the hub,
 * for an older computer); on the computer the check costs milliseconds, and reading
 * a folder that is no repo is wasted work on every poll.
 */
export async function readGitSummary(
  ops: PanelReadOps,
  input: GitOpInput<'getGitSummary'>,
  opts: { overlap: boolean }
): Promise<GitSummary> {
  const { path, checkoutPath, statusPath } = input
  const readAll = () =>
    Promise.all([
      ops.getCurrentBranch(path),
      ops.getRemoteUrl(path),
      checkoutPath ? ops.getCurrentBranch(checkoutPath) : null,
      statusPath ? ops.getStatusSummary(statusPath) : null
    ])
  const reads = opts.overlap ? readAll() : null
  // Settled before it is judged: an early-started read never rejects unobserved.
  reads?.catch(() => undefined)
  let isRepo: boolean
  try {
    isRepo = await ops.isGitRepo(path)
  } catch (err) {
    return { kind: 'checkFailed', message: errorMessage(err) }
  }
  if (!isRepo) return { kind: 'notRepo' }
  try {
    const [branch, remoteUrl, checkoutBranch, status] = await (reads ?? readAll())
    // The branch the task works on: its own checkout's, else the project's.
    const activeBranch = checkoutPath ? checkoutBranch : branch
    const upstream =
      statusPath && activeBranch ? await ops.getAheadBehindUpstream(statusPath, activeBranch) : null
    return { kind: 'repo', branch, remoteUrl, checkoutBranch, status, upstream }
  } catch {
    return { kind: 'readFailed' }
  }
}

/** The commit graph: of the base branch (as given, else the checked-out one) and,
 *  with `showBranches`, every branch forked from or merged into it. */
export async function readBranchGraph(
  ops: PanelReadOps,
  input: GitOpInput<'getBranchGraph'>
): Promise<BranchGraphRead> {
  const branch = await ops.getCurrentBranch(input.path)
  const baseBranch = input.baseBranch || branch || 'main'
  const branches = new Set<string>([baseBranch])
  if (input.showBranches) {
    const related = await ops.resolveChildBranches(input.path, baseBranch)
    for (const child of related.children) branches.add(child)
    for (const merged of related.merged) branches.add(merged)
  }
  const graph = await ops.getResolvedCommitDag(input.path, input.limit, [...branches], baseBranch)
  return { branch, graph }
}
