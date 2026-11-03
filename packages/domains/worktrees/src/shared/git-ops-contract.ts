/**
 * The git panel's operations, declared ONCE: each op's input schema and which of
 * its fields are filesystem paths. The hub's `worktrees` router validates with it,
 * and the computer's `git.op` handler validates the same input again and jails
 * every path it names before running the op (`@slayzone/worktrees/git-ops`).
 *
 * `paths`: absolute paths on the machine that runs the op (a checkout, a worktree).
 * `repoRelative`: paths INSIDE the op's repo (a file to stage, a conflict to write) —
 * each must stay inside it, never `../` out of it.
 *
 * Pure data + zod: lean enough for the renderer and the computer to import.
 */
import { z } from 'zod'

const s = z.string()
const b = z.boolean()
const n = z.number()
const u = z.unknown()

type Fields<I extends z.ZodObject> = keyof z.infer<I> & string

export interface GitOpDef<I extends z.ZodObject = z.ZodObject> {
  readonly input: I
  readonly paths: readonly Fields<I>[]
  readonly repoRelative: readonly Fields<I>[]
}

function op<I extends z.ZodObject>(
  input: I,
  paths: readonly Fields<I>[],
  repoRelative: readonly Fields<I>[] = []
): GitOpDef<I> {
  return { input, paths, repoRelative }
}

const at = z.object({ path: s })
const repo = z.object({ repoPath: s })

export const gitOpsContract = {
  isGitRepo: op(at, ['path']),
  init: op(at, ['path']),
  getCurrentBranch: op(at, ['path']),
  listBranches: op(at, ['path']),
  checkoutBranch: op(z.object({ path: s, branch: s }), ['path']),
  createBranch: op(z.object({ path: s, branch: s }), ['path']),
  hasUncommittedChanges: op(at, ['path']),
  mergeIntoParent: op(z.object({ projectPath: s, parentBranch: s, sourceBranch: s }), [
    'projectPath'
  ]),
  abortMerge: op(at, ['path']),
  isMergeInProgress: op(at, ['path']),
  getConflictedFiles: op(at, ['path']),
  getWorkingDiff: op(z.object({ path: s, opts: u.optional() }), ['path']),
  stageFile: op(z.object({ path: s, filePath: s }), ['path'], ['filePath']),
  unstageFile: op(z.object({ path: s, filePath: s }), ['path'], ['filePath']),
  discardFile: op(
    z.object({ path: s, filePath: s, untracked: b.optional() }),
    ['path'],
    ['filePath']
  ),
  stageAll: op(at, ['path']),
  unstageAll: op(at, ['path']),
  getFileDiff: op(
    z.object({ repoPath: s, filePath: s, staged: b, opts: u.optional() }),
    ['repoPath'],
    ['filePath']
  ),
  getUntrackedFileDiff: op(z.object({ repoPath: s, filePath: s }), ['repoPath'], ['filePath']),
  getUntrackedFileDiffs: op(
    z.object({ repoPath: s, filePaths: z.array(s) }),
    ['repoPath'],
    ['filePaths']
  ),
  getConflictContent: op(z.object({ repoPath: s, filePath: s }), ['repoPath'], ['filePath']),
  writeResolvedFile: op(
    z.object({ repoPath: s, filePath: s, content: s }),
    ['repoPath'],
    ['filePath']
  ),
  commitFiles: op(z.object({ repoPath: s, message: s }), ['repoPath']),

  isRebaseInProgress: op(at, ['path']),
  getRebaseProgress: op(repo, ['repoPath']),
  abortRebase: op(at, ['path']),
  continueRebase: op(at, ['path']),
  skipRebaseCommit: op(at, ['path']),
  getMergeContext: op(repo, ['repoPath']),

  getRecentCommits: op(z.object({ repoPath: s, count: n.optional() }), ['repoPath']),
  getAheadBehind: op(z.object({ repoPath: s, branch: s, upstream: s }), ['repoPath']),
  getStatusSummary: op(repo, ['repoPath']),
  isDirty: op(at, ['path']),
  getRemoteUrl: op(at, ['path']),
  getAheadBehindUpstream: op(z.object({ path: s, branch: s }), ['path']),
  fetch: op(at, ['path']),
  // No branch input: pushes what is checked out at `path` (see gitPush).
  push: op(z.object({ path: s, force: b.optional() }), ['path']),
  pull: op(at, ['path']),

  getDefaultBranch: op(at, ['path']),
  listBranchesDetailed: op(at, ['path']),
  listRemoteBranches: op(at, ['path']),
  getMergeBase: op(z.object({ path: s, branch1: s, branch2: s }), ['path']),
  getCommitsSince: op(z.object({ path: s, sinceRef: s, branch: s }), ['path']),
  getCommitsBeforeRef: op(z.object({ path: s, ref: s, count: n.optional() }), ['path']),
  deleteBranch: op(z.object({ path: s, branch: s, force: b.optional() }), ['path']),
  pruneRemote: op(at, ['path']),

  rebaseOnto: op(z.object({ path: s, ontoBranch: s }), ['path']),
  mergeFrom: op(z.object({ path: s, branch: s }), ['path']),
  getDiffStats: op(z.object({ path: s, ref: s }), ['path']),
  getWorktreeMetadata: op(at, ['path']),
  getCommitDag: op(z.object({ path: s, limit: n, branches: z.array(s).optional() }), ['path']),
  resolveChildBranches: op(z.object({ path: s, baseBranch: s }), ['path']),
  getIgnoredFileTree: op(repo, ['repoPath']),
  copyIgnoredFiles: op(
    z.object({
      repoPath: s,
      worktreePath: s,
      paths: z.array(s),
      mode: z.enum(['all', 'custom']).optional()
    }),
    ['repoPath', 'worktreePath'],
    ['paths']
  ),

  getResolvedCommitDag: op(
    z.object({ path: s, limit: n, branches: z.array(s).optional(), baseBranch: s }),
    ['path']
  ),
  getResolvedForkGraph: op(
    z.object({
      targetPath: s,
      repoPath: s,
      activeBranch: s,
      compareBranch: s,
      activeBranchLabel: s,
      compareBranchLabel: s
    }),
    ['targetPath', 'repoPath']
  ),
  getResolvedUpstreamGraph: op(z.object({ repoPath: s, branch: s }), ['repoPath']),
  getResolvedRecentCommits: op(z.object({ path: s, count: n, branchName: s }), ['path']),

  listStashes: op(repo, ['repoPath']),
  createStash: op(z.object({ repoPath: s, message: s, includeUntracked: b, keepIndex: b }), [
    'repoPath'
  ]),
  applyStash: op(z.object({ repoPath: s, index: n }), ['repoPath']),
  popStash: op(z.object({ repoPath: s, index: n }), ['repoPath']),
  dropStash: op(z.object({ repoPath: s, index: n }), ['repoPath']),
  branchFromStash: op(z.object({ repoPath: s, index: n, branchName: s }), ['repoPath']),
  getStashDiff: op(z.object({ repoPath: s, index: n }), ['repoPath']),

  hasGithubRemote: op(repo, ['repoPath']),
  // Internal: `createPr`'s first step (no procedure of its own).
  ensureBranchPushed: op(repo, ['repoPath'])
} as const

/** Ops that are steps of a composite procedure, not procedures themselves. */
export const GIT_INTERNAL_OPS: ReadonlySet<string> = new Set(['ensureBranchPushed'])

export type GitOpName = keyof typeof gitOpsContract
export type GitOpInput<K extends GitOpName> = z.infer<(typeof gitOpsContract)[K]['input']>

function fieldValues(input: Record<string, unknown>, fields: readonly string[]): string[] {
  const out: string[] = []
  for (const f of fields) {
    const v = input[f]
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x)
  }
  return out
}

/** The absolute paths `input` names for `op`, in contract order (the repo first). */
export function gitOpAbsolutePaths<K extends GitOpName>(op: K, input: GitOpInput<K>): string[] {
  return fieldValues(input as Record<string, unknown>, gitOpsContract[op].paths)
}

/** The repo-relative paths `input` names for `op`. */
export function gitOpRepoRelativePaths<K extends GitOpName>(op: K, input: GitOpInput<K>): string[] {
  return fieldValues(input as Record<string, unknown>, gitOpsContract[op].repoRelative)
}

export function isGitOpName(name: string): name is GitOpName {
  return Object.hasOwn(gitOpsContract, name)
}
