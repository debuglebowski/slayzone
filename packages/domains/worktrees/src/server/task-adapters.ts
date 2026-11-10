import { existsSync, rmSync } from 'node:fs'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'
import type { WorktreeExecAdapters } from '@slayzone/task/server'
import {
  removeWorktree,
  createWorktree,
  runWorktreeSetupScript,
  getCurrentBranch,
  isGitRepo,
  copyIgnoredFiles
} from './git-worktree'

// In-process implementations of the task-owned worktree seams
// (`TaskRuntimeAdapters.worktrees` / `.worktreePolicy` in `@slayzone/task/server`).
// They live here, not in task, because worktrees builds on task: the composition
// roots (hub, Electron main) pass them to `configureTaskRuntimeAdapters`.

/**
 * The workspace ops below run on the hub's own disk, so each refuses first (as a
 * rejection) on a hub with `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-06) — this default is
 * live before the hub installs the routing adapter, and stays live if that init
 * fails. The two hub-storage ops are hub-owned and stay.
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
  // This host's own disk: no computer to record.
  createWorktree: onHubDisk(
    'create',
    async (_taskId, repoPath, worktreePath, branch, sourceBranch) => {
      await createWorktree(repoPath, worktreePath, branch, sourceBranch)
      return { computerId: null }
    }
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
  pathExists: onHubDisk('path_exists', (_taskId, p) => existsSync(p)),
  hubPathExists: (p) => existsSync(p),
  removeArtifactDir: (absDir) => rmSync(absDir, { recursive: true, force: true })
}

export { defaultWorktreePolicyAdapters } from './hub-task-adapters'
