/**
 * The hub's task-owned worktree seams (`TaskRuntimeAdapters.worktrees` /
 * `.worktreePolicy`). The hub runs no git and reads no checkout: every workspace op
 * refuses ("connect a computer") — live before the hub installs the routing adapters
 * (`createRemoteWorktreeAdapters`, which keeps this set as its `local` for the
 * hub-owned ops). Hub-owned and kept: the two hub-storage ops.
 */
import { existsSync, rmSync } from 'node:fs'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import type { WorktreeExecAdapters, WorktreePolicyAdapters } from '@slayzone/task/server'
import { resolveCopyBehavior } from './composite-ops'
import { DEFAULT_WORKTREE_BASE_PATH_TEMPLATE, resolveWorktreeBasePathTemplate } from '../shared'

const onComputer =
  (op: string) =>
  async (..._args: unknown[]): Promise<never> =>
    refuseNoComputer({ op: `worktree.${op}` })

export const hubWorktreeExecAdapters: WorktreeExecAdapters = {
  createWorktree: onComputer('create'),
  removeWorktree: onComputer('remove'),
  runWorktreeSetupScript: onComputer('setup'),
  copyIgnoredFiles: onComputer('copy_ignored'),
  getCurrentBranch: onComputer('branch'),
  isGitRepo: onComputer('is_git_repo'),
  pathExists: onComputer('path_exists'),
  hubPathExists: (p) => existsSync(p),
  removeArtifactDir: (absDir) => rmSync(absDir, { recursive: true, force: true })
}

/** Hub-side worktree policy reads task ops make (never routed). */
export const defaultWorktreePolicyAdapters: WorktreePolicyAdapters = {
  resolveCopyBehavior,
  defaultBasePathTemplate: DEFAULT_WORKTREE_BASE_PATH_TEMPLATE,
  resolveBasePathTemplate: resolveWorktreeBasePathTemplate
}
