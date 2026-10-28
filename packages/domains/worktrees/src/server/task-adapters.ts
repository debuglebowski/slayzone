import { existsSync, rmSync } from 'node:fs'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'
import type { WorktreeExecAdapters, WorktreePolicyAdapters } from '@slayzone/task/server'
import {
  removeWorktree,
  createWorktree,
  runWorktreeSetupScript,
  getCurrentBranch,
  isGitRepo,
  copyIgnoredFiles
} from './git-worktree'
import {
  getColor as getWorktreeColor,
  ensureProjectColors as ensureProjectWorktreeColors
} from './color-registry'
import { resolveCopyBehavior } from './composite-ops'
import { DEFAULT_WORKTREE_BASE_PATH_TEMPLATE, resolveWorktreeBasePathTemplate } from '../shared'

// In-process implementations of the task-owned worktree seams
// (`TaskRuntimeAdapters.worktrees` / `.worktreePolicy` in `@slayzone/task/server`).
// They live here, not in task, because worktrees builds on task: the composition
// roots (hub, Electron main) pass them to `configureTaskRuntimeAdapters`.

/**
 * The workspace ops below run on the hub's own disk, so each refuses first (as a
 * rejection) on a hub with `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-06) — this default is
 * live before the hub installs the routing adapter, and stays live if that init
 * fails. Colors and the two hub-storage ops are hub-owned and stay.
 */
const onHubDisk =
  <A extends unknown[], R>(op: string, fn: (...args: A) => R | Promise<R>) =>
  async (...args: A): Promise<R> => {
    assertHubLocalExecEnabled({ op: `worktree.${op}` })
    return fn(...args)
  }

/**
 * Default exec adapters wrap the direct worktree imports 1:1. The seam (not the
 * import) is what the hub rebinds to a computer-backed implementation
 * (`createRemoteWorktreeAdapters`, which keeps this object as its `local`).
 */
export const defaultWorktreeExecAdapters: WorktreeExecAdapters = {
  // The in-process impls run on the hub, so they IGNORE `taskId` — it exists only
  // so a routing impl can resolve which computer the work belongs to.
  createWorktree: onHubDisk('create', (_taskId, repoPath, worktreePath, branch, sourceBranch) =>
    createWorktree(repoPath, worktreePath, branch, sourceBranch)
  ),
  removeWorktree: onHubDisk('remove', (_taskId, projectPath, worktreePath) =>
    removeWorktree(projectPath, worktreePath)
  ),
  runWorktreeSetupScript: onHubDisk('setup', (_taskId, worktreePath, repoPath, sourceBranch) =>
    runWorktreeSetupScript(worktreePath, repoPath, sourceBranch)
  ),
  copyIgnoredFiles: onHubDisk(
    'copy_ignored',
    (_taskId, repoPath, worktreePath, behavior, customPaths) =>
      copyIgnoredFiles(repoPath, worktreePath, behavior, customPaths)
  ),
  getCurrentBranch: onHubDisk('branch', (_taskId, repoPath) => getCurrentBranch(repoPath)),
  isGitRepo: onHubDisk('is_git_repo', (_taskId, path) => isGitRepo(path)),
  getWorktreeColor,
  ensureProjectWorktreeColors,
  pathExists: onHubDisk('path_exists', (_taskId, p) => existsSync(p)),
  hubPathExists: (p) => existsSync(p),
  removeArtifactDir: (absDir) => rmSync(absDir, { recursive: true, force: true })
}

/** Hub-side worktree policy reads task ops make (never routed). */
export const defaultWorktreePolicyAdapters: WorktreePolicyAdapters = {
  resolveCopyBehavior,
  defaultBasePathTemplate: DEFAULT_WORKTREE_BASE_PATH_TEMPLATE,
  resolveBasePathTemplate: resolveWorktreeBasePathTemplate
}
