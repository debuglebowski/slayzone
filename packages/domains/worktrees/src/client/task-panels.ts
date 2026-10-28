import { lazyWithPreload } from '@slayzone/ui'
import type { TaskPanels } from '@slayzone/task/client/TaskPanels'
import { useProjectRepos } from './useProjectRepos'
import { useDetectedRepos } from './useDetectedRepos'

/**
 * This feature's half of the task page's injected panels (see task's
 * TaskPanels.ts). The app spreads it into what it passes to registerTaskPanels.
 * The panel stays a lazy chunk; `.preload()` warms it (useIdlePreload).
 */
export const UnifiedGitPanel = lazyWithPreload(() =>
  import('../index').then((m) => ({ default: m.UnifiedGitPanel }))
)

export const worktreesTaskPanels = {
  UnifiedGitPanel,
  useProjectRepos,
  useDetectedRepos
} satisfies Pick<TaskPanels, 'UnifiedGitPanel' | 'useProjectRepos' | 'useDetectedRepos'>
