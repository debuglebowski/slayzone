export { registerWorktreeHandlers, resolveCopyBehavior } from './handlers'
export { removeWorktree, createWorktree, runWorktreeSetupScript, runWorktreeSetupScriptSync, getCurrentBranch, isGitRepo, copyIgnoredFiles, getIgnoredFileTree } from './git-worktree'
export { ensureColors as ensureWorktreeColors, getColor as getWorktreeColor, getProjectColors as getProjectWorktreeColors, ensureProjectColors as ensureProjectWorktreeColors } from './color-registry'
