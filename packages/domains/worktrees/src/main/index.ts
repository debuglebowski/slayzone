export { registerWorktreeHandlers } from './handlers'
export { resolveCopyBehavior } from './composite-ops'
export { getGitWatcher, closeGitWatcher } from './git-watcher'
export {
  removeWorktree,
  createWorktree,
  runWorktreeSetupScript,
  runWorktreeSetupScriptSync,
  getCurrentBranch,
  isGitRepo,
  copyIgnoredFiles,
  getIgnoredFileTree
} from './git-worktree'
export {
  ensureColors as ensureWorktreeColors,
  getColor as getWorktreeColor,
  getProjectColors as getProjectWorktreeColors,
  ensureProjectColors as ensureProjectWorktreeColors
} from './color-registry'
