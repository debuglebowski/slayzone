/**
 * The copy dialog's lazy ignored-file tree, routed (`worktrees.openIgnoredTree`,
 * `listIgnoredTree`, `matchIgnoredTree`).
 *
 * A computer that answers bounded reads holds the index itself: each op is one
 * `git.op` request answering one bounded page. An older computer only knows the
 * whole tree (`getIgnoredFileTree`): the hub asks for it once, holds its index under
 * a `hub:` id and answers every page itself — the dialog has one code path, and
 * against an old computer it is no worse than before (one whole reply, the frame
 * limit its backstop).
 *
 * A hub-held id is bound to the scope (task/project) and repo that opened it: any
 * other caller gets IGNORED_TREE_EXPIRED, like an unknown id.
 *
 * @module worktrees/server/ignored-tree-routing
 */
import type { Page } from '@slayzone/platform/bounded-reads'
import type { SlayzoneDb } from '@slayzone/platform'
import type { GitOpInput } from '../shared/git-ops-contract'
import type { IgnoredEntry, IgnoredFileNode, IgnoredMatch, IgnoredTreeOpen } from '../shared/types'
import { executeGitOp, gitComputerSupports } from './git-op-routing'
import { ignoredIndexFromTree } from './ignored-index'
import { IgnoredTreeStore } from './ignored-trees'
import type { WorktreesComputerTarget } from './worktrees-router-deps'

const HUB_PREFIX = 'hub:'
/** Indexes of older computers' trees, held by this hub. */
const hubTrees = new IgnoredTreeStore({ idPrefix: HUB_PREFIX })

type Routed<T> = T & { target?: WorktreesComputerTarget }

/** The hub store's key: the scope and repo together, so an id answers only its opener. */
function scopedRepo(target: WorktreesComputerTarget | undefined, repoPath: string): string {
  return JSON.stringify([
    target?.taskId ?? null,
    target?.projectId ?? null,
    target?.projectWide === true,
    repoPath
  ])
}

export async function openIgnoredTreeRouted(
  input: Routed<GitOpInput<'openIgnoredTree'>>,
  db: SlayzoneDb
): Promise<IgnoredTreeOpen> {
  if (await gitComputerSupports(input.target, 'boundedReads'))
    return executeGitOp('openIgnoredTree', input, false, db)
  const tree = (await executeGitOp(
    'getIgnoredFileTree',
    { repoPath: input.repoPath, target: input.target },
    false,
    db
  )) as IgnoredFileNode[]
  return hubTrees.adopt(scopedRepo(input.target, input.repoPath), ignoredIndexFromTree(tree))
}

export async function listIgnoredTreeRouted(
  input: Routed<GitOpInput<'listIgnoredTree'>>,
  db: SlayzoneDb
): Promise<Page<IgnoredEntry>> {
  if (!input.treeId.startsWith(HUB_PREFIX)) return executeGitOp('listIgnoredTree', input, false, db)
  const { target, ...q } = input
  return hubTrees.list({ ...q, repoPath: scopedRepo(target, q.repoPath) })
}

export async function matchIgnoredTreeRouted(
  input: Routed<GitOpInput<'matchIgnoredTree'>>,
  db: SlayzoneDb
): Promise<Page<IgnoredMatch>> {
  if (!input.treeId.startsWith(HUB_PREFIX))
    return executeGitOp('matchIgnoredTree', input, false, db)
  const { target, ...q } = input
  return hubTrees.match({ ...q, repoPath: scopedRepo(target, q.repoPath) })
}
