import { lazyWithPreload } from '@slayzone/ui'
import type { TaskPanels } from '@slayzone/task/client/TaskPanels'
import { useArtifacts } from './useArtifacts'

/**
 * This feature's half of the task page's injected panels (see task's
 * TaskPanels.ts). The app spreads it into what it passes to registerTaskPanels.
 * The panel stays a lazy chunk; `.preload()` warms it (useIdlePreload).
 */
export const ArtifactsPanel = lazyWithPreload(() =>
  import('./index').then((m) => ({ default: m.ArtifactsPanel }))
)

export const artifactsTaskPanels = {
  ArtifactsPanel,
  useArtifacts
} satisfies Pick<TaskPanels, 'ArtifactsPanel' | 'useArtifacts'>
