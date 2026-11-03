/**
 * `@slayzone/worktrees/hub`: what the HUB uses of this domain — the router, the
 * routing to computers, and the hub-owned pieces (colors, policy, events). Nothing
 * here runs git or `gh` or reads a checkout (asserted by lint:server-boundary: the
 * hub bundle must not reach exec-async). The `./server` barrel keeps the local
 * implementations for hosts and tests that run git themselves.
 */
export { worktreesRouter, type WorktreesRouter, type WorktreesMounts } from './worktrees-router'
export {
  setWorktreesRouterDeps,
  getWorktreesRouterDeps,
  type WorktreesRouterDeps,
  type WorktreesComputerTarget
} from './worktrees-router-deps'
export {
  setGitOpTransport,
  executeGitOp,
  gitTargetForPath,
  deliverGitWatchEvent,
  gitWatchComputerGone,
  type GitOpTransport
} from './git-op-routing'
export { setGhExecutor, type GhExecutor } from './gh-cli'
export { setAiCommandRunner, type AiCommandRunner } from './merge-ai'
export { hubWorktreeExecAdapters, defaultWorktreePolicyAdapters } from './hub-task-adapters'
export {
  setWorktreeColorDetector,
  __resetForTests as resetWorktreeColorsForTest
} from './color-registry'
export { detectChildRepos, invalidateProjectReposCache } from './list-project-repos'
export { getGitWatcher, closeGitWatcher } from './git-watcher'
export { worktreesEvents, type WorktreesEventMap } from './events'
